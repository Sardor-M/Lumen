import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname, basename, relative } from 'node:path';
import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';

type ObsidianConfig = {
    vault_path: string;
    /** Subdirectory inside the vault to scope — useful when the Obsidian Web Clipper
     *  is configured to drop into a specific folder like `Clippings/`. */
    clippings_subdir?: string;
};

type ObsidianState = {
    file_mtimes: Record<string, string>;
};

const MAX_FILES_PER_PULL = 500;

/**
 * Obsidian vault connector. Walks a user's vault (or a specific Clippings
 * subfolder), parses YAML frontmatter produced by the Obsidian Web Clipper,
 * and promotes the clip URL/title/date into the ExtractionResult so that
 * dedup works across repeat clippings of the same article.
 */
export const obsidianHandler: ConnectorHandler = {
    type: 'obsidian',

    parseTarget(target, options) {
        const absPath = resolve(target.replace(/^~(?=$|\/)/, process.env.HOME ?? ''));
        if (!existsSync(absPath)) {
            throw new Error(`Vault path does not exist: ${absPath}`);
        }
        if (!statSync(absPath).isDirectory()) {
            throw new Error(`Not a directory: ${absPath}`);
        }

        const subdir = typeof options.subdir === 'string' ? options.subdir : undefined;
        const rootForWalk = subdir ? join(absPath, subdir) : absPath;
        if (subdir && !existsSync(rootForWalk)) {
            throw new Error(`Clippings subdirectory not found: ${rootForWalk}`);
        }

        const slug = absPath
            .replace(/^[/\\]+/, '')
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();

        return {
            id: `obsidian:${slug}${subdir ? `:${subdir.replace(/[^a-z0-9]+/gi, '-')}` : ''}`,
            name: basename(absPath),
            config: {
                vault_path: absPath,
                clippings_subdir: subdir,
            } as ObsidianConfig,
            initialState: { file_mtimes: {} } as ObsidianState,
        };
    },

    pull(connector: Connector): Promise<PullResult> {
        const config = parseConfig(connector.config);
        const state = parseState(connector.state);
        const root = config.clippings_subdir
            ? join(config.vault_path, config.clippings_subdir)
            : config.vault_path;

        if (!existsSync(root)) {
            return Promise.reject(
                new Error(
                    `Vault path no longer exists: ${root}. Remove with \`lumen watch remove ${connector.id}\``,
                ),
            );
        }

        const files = collectMarkdownFiles(root);
        const newState: ObsidianState = { file_mtimes: { ...state.file_mtimes } };
        const items: ExtractionResult[] = [];

        for (const file of files) {
            if (items.length >= MAX_FILES_PER_PULL) break;

            let mtimeIso: string;
            try {
                mtimeIso = statSync(file).mtime.toISOString();
            } catch {
                continue;
            }

            const recorded = state.file_mtimes[file];
            if (recorded === mtimeIso) continue;

            const raw = safeRead(file);
            if (raw === null || !raw.trim()) {
                newState.file_mtimes[file] = mtimeIso;
                continue;
            }

            const { frontmatter, body } = parseFrontmatter(raw);
            if (!body.trim()) {
                newState.file_mtimes[file] = mtimeIso;
                continue;
            }

            const rel = relative(config.vault_path, file) || basename(file);
            items.push(renderItem(rel, body, frontmatter, file, mtimeIso, config.vault_path));
            newState.file_mtimes[file] = mtimeIso;
        }

        /** Prune state entries for files that were deleted from the vault. */
        const liveSet = new Set(files);
        for (const path of Object.keys(newState.file_mtimes)) {
            if (!liveSet.has(path)) delete newState.file_mtimes[path];
        }

        return Promise.resolve({ new_items: items, new_state: newState });
    },
};

function renderItem(
    relativePath: string,
    body: string,
    frontmatter: Record<string, unknown>,
    absolutePath: string,
    mtimeIso: string,
    vaultPath: string,
): ExtractionResult {
    const fmTitle = stringField(frontmatter, 'title');
    const fmUrl = stringField(frontmatter, 'source') ?? stringField(frontmatter, 'url');
    const fmAuthor = stringField(frontmatter, 'author');
    const fmPublished = stringField(frontmatter, 'published') ?? stringField(frontmatter, 'date');
    const fmClipped = stringField(frontmatter, 'clipped') ?? stringField(frontmatter, 'created');
    const fmTags = tagsField(frontmatter);

    const title = fmTitle ?? titleFromPath(relativePath);

    return {
        title,
        content: body,
        url: fmUrl ?? null,
        source_type: 'url',
        language: null,
        metadata: {
            vault_path: vaultPath,
            relative_path: relativePath,
            absolute_path: absolutePath,
            mtime: mtimeIso,
            author: fmAuthor,
            published: fmPublished,
            clipped_at: fmClipped,
            tags: fmTags,
            obsidian_frontmatter: frontmatter,
        },
    };
}

function parseConfig(raw: string): ObsidianConfig {
    try {
        const parsed = JSON.parse(raw) as Partial<ObsidianConfig>;
        if (typeof parsed.vault_path !== 'string') {
            throw new Error('obsidian connector config missing "vault_path"');
        }
        return {
            vault_path: parsed.vault_path,
            clippings_subdir:
                typeof parsed.clippings_subdir === 'string' ? parsed.clippings_subdir : undefined,
        };
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new Error('obsidian connector config is not valid JSON');
        }
        throw err;
    }
}

function parseState(raw: string): ObsidianState {
    try {
        const parsed = JSON.parse(raw) as Partial<ObsidianState>;
        const mtimes =
            typeof parsed.file_mtimes === 'object' && parsed.file_mtimes !== null
                ? (parsed.file_mtimes as Record<string, string>)
                : {};
        return { file_mtimes: mtimes };
    } catch {
        return { file_mtimes: {} };
    }
}

function collectMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            /** Obsidian's own metadata folder — skip. */
            if (entry.name === '.obsidian') continue;
            if (entry.name.startsWith('.')) continue;

            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
                results.push(full);
            }
        }
    }
    return results.sort();
}

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
}

function titleFromPath(relativePath: string): string {
    return relativePath
        .replace(/\.\w+$/, '')
        .replace(/[/\\]/g, ' · ')
        .replace(/[-_]/g, ' ');
}

/**
 * Minimal YAML frontmatter parser. Handles the flat key/value and array shapes
 * that the Obsidian Web Clipper emits; nested blocks get returned as strings.
 */
export function parseFrontmatter(raw: string): {
    frontmatter: Record<string, unknown>;
    body: string;
} {
    if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
        return { frontmatter: {}, body: raw };
    }

    const lines = raw.split(/\r?\n/);
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            end = i;
            break;
        }
    }
    if (end === -1) return { frontmatter: {}, body: raw };

    const frontmatter: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentList: string[] | null = null;

    for (let i = 1; i < end; i++) {
        const line = lines[i];
        if (!line.trim()) {
            currentKey = null;
            currentList = null;
            continue;
        }

        const listMatch = /^\s*-\s+(.*)$/.exec(line);
        if (listMatch && currentKey && currentList) {
            currentList.push(stripQuotes(listMatch[1].trim()));
            frontmatter[currentKey] = currentList;
            continue;
        }

        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;

        const key = kv[1];
        const value = kv[2];

        if (!value) {
            currentKey = key;
            currentList = [];
            frontmatter[key] = currentList;
            continue;
        }

        if (value.startsWith('[') && value.endsWith(']')) {
            frontmatter[key] = value
                .slice(1, -1)
                .split(',')
                .map((v) => stripQuotes(v.trim()))
                .filter((v) => v.length > 0);
        } else {
            frontmatter[key] = stripQuotes(value.trim());
        }
        currentKey = null;
        currentList = null;
    }

    const body = lines.slice(end + 1).join('\n');
    return { frontmatter, body };
}

function stripQuotes(value: string): string {
    if (value.length >= 2) {
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            return value.slice(1, -1);
        }
    }
    return value;
}

function stringField(fm: Record<string, unknown>, key: string): string | null {
    const value = fm[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function tagsField(fm: Record<string, unknown>): string[] | null {
    const value = fm.tags ?? fm.tag;
    if (Array.isArray(value)) {
        return value.filter((v) => typeof v === 'string') as string[];
    }
    if (typeof value === 'string') {
        return value.split(/[,\s]+/).filter((v) => v.length > 0);
    }
    return null;
}
