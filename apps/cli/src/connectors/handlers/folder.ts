import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname, basename, relative } from 'node:path';
import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';

type FolderConfig = {
    path: string;
    /** Extra extensions to include beyond the defaults. */
    extra_extensions?: string[];
};

type FolderState = {
    /** absolute_path → last-observed mtime ISO string. */
    file_mtimes: Record<string, string>;
};

const DEFAULT_TEXT_EXTENSIONS = new Set([
    '.md',
    '.txt',
    '.markdown',
    '.rst',
    '.org',
    '.adoc',
    '.tex',
]);

const MAX_FILES_PER_PULL = 500;

export const folderHandler: ConnectorHandler = {
    type: 'folder',

    parseTarget(target, _options) {
        const absPath = resolve(target.replace(/^~(?=$|\/)/, process.env.HOME ?? ''));
        if (!existsSync(absPath)) {
            throw new Error(`Folder does not exist: ${absPath}`);
        }
        if (!statSync(absPath).isDirectory()) {
            throw new Error(`Not a directory: ${absPath}`);
        }

        const slug = absPath
            .replace(/^[/\\]+/, '')
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();

        return {
            id: `folder:${slug}`,
            name: basename(absPath),
            config: { path: absPath } as FolderConfig,
            initialState: { file_mtimes: {} } as FolderState,
        };
    },

    pull(connector: Connector): Promise<PullResult> {
        const config = parseConfig(connector.config);
        const state = parseState(connector.state);
        const extensions = new Set([
            ...DEFAULT_TEXT_EXTENSIONS,
            ...(config.extra_extensions ?? []).map((e) => e.toLowerCase()),
        ]);

        if (!existsSync(config.path)) {
            return Promise.reject(
                new Error(
                    `Folder no longer exists: ${config.path}. Remove with \`lumen watch remove ${connector.id}\``,
                ),
            );
        }

        const files = collectFiles(config.path, extensions);
        const newState: FolderState = { file_mtimes: { ...state.file_mtimes } };
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

            const content = safeRead(file);
            if (content === null || !content.trim()) {
                newState.file_mtimes[file] = mtimeIso;
                continue;
            }

            const rel = relative(config.path, file) || basename(file);
            items.push({
                title: titleFromPath(rel),
                content,
                url: null,
                source_type: 'file',
                language: null,
                metadata: {
                    folder_root: config.path,
                    relative_path: rel,
                    extension: extname(file),
                    mtime: mtimeIso,
                },
            });
            newState.file_mtimes[file] = mtimeIso;
        }

        /** Prune state entries for files that no longer exist — keeps the
         *  row small even after big deletions in the watched folder. */
        const liveSet = new Set(files);
        for (const path of Object.keys(newState.file_mtimes)) {
            if (!liveSet.has(path)) delete newState.file_mtimes[path];
        }

        return Promise.resolve({ new_items: items, new_state: newState });
    },
};

function parseConfig(raw: string): FolderConfig {
    try {
        const parsed = JSON.parse(raw) as Partial<FolderConfig>;
        if (typeof parsed.path !== 'string') {
            throw new Error('folder connector config missing "path"');
        }
        return {
            path: parsed.path,
            extra_extensions: Array.isArray(parsed.extra_extensions)
                ? parsed.extra_extensions
                : undefined,
        };
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new Error('folder connector config is not valid JSON');
        }
        throw err;
    }
}

function parseState(raw: string): FolderState {
    try {
        const parsed = JSON.parse(raw) as Partial<FolderState>;
        const mtimes =
            typeof parsed.file_mtimes === 'object' && parsed.file_mtimes !== null
                ? (parsed.file_mtimes as Record<string, string>)
                : {};
        return { file_mtimes: mtimes };
    } catch {
        return { file_mtimes: {} };
    }
}

function collectFiles(dir: string, extensions: Set<string>): string[] {
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
            /** Skip dotfiles, node_modules, and common build output. */
            if (entry.name.startsWith('.')) continue;
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;

            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
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
