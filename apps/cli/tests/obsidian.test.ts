import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertConnector, getConnector } from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler } from '../src/connectors/registry.js';
import { obsidianHandler, parseFrontmatter } from '../src/connectors/handlers/obsidian.js';
import type { Connector } from '../src/types/index.js';

let lumenDir: string;
let vaultDir: string;

beforeEach(() => {
    lumenDir = mkdtempSync(join(tmpdir(), 'lumen-obsidian-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'lumen-vault-'));
    setDataDir(lumenDir);
    getDb();
    registerHandler(obsidianHandler);
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(lumenDir, { recursive: true, force: true });
    if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true, force: true });
});

function seedConnector(overrides: Partial<Connector> = {}): Connector {
    const c: Connector = {
        id: 'obsidian:test',
        type: 'obsidian',
        name: 'vault',
        config: JSON.stringify({ vault_path: vaultDir }),
        state: JSON.stringify({ file_mtimes: {} }),
        interval_seconds: 3600,
        last_run_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
    insertConnector(c);
    return c;
}

function clippingWithFrontmatter(fm: Record<string, string | string[]>, body: string): string {
    const lines = ['---'];
    for (const [key, value] of Object.entries(fm)) {
        if (Array.isArray(value)) {
            lines.push(`${key}: [${value.map((v) => `"${v}"`).join(', ')}]`);
        } else {
            lines.push(`${key}: "${value}"`);
        }
    }
    lines.push('---', '', body);
    return lines.join('\n');
}

describe('parseFrontmatter', () => {
    it('returns empty frontmatter and full body when no delimiter', () => {
        const { frontmatter, body } = parseFrontmatter('# Just content\n\nNo frontmatter here.');
        expect(frontmatter).toEqual({});
        expect(body).toContain('Just content');
    });

    it('parses flat key-value pairs with quoted strings', () => {
        const raw = ['---', 'title: "An Article"', 'author: "Jane Doe"', '---', '', 'Body.'].join(
            '\n',
        );
        const { frontmatter, body } = parseFrontmatter(raw);
        expect(frontmatter.title).toBe('An Article');
        expect(frontmatter.author).toBe('Jane Doe');
        expect(body.trim()).toBe('Body.');
    });

    it('parses inline array syntax', () => {
        const raw = ['---', 'tags: ["reading", "web", "tools"]', '---', '', 'Body.'].join('\n');
        const { frontmatter } = parseFrontmatter(raw);
        expect(frontmatter.tags).toEqual(['reading', 'web', 'tools']);
    });

    it('parses block-list arrays', () => {
        const raw = ['---', 'tags:', '  - reading', '  - web', '---', '', 'Body.'].join('\n');
        const { frontmatter } = parseFrontmatter(raw);
        expect(frontmatter.tags).toEqual(['reading', 'web']);
    });

    it('returns empty frontmatter when the closing delimiter is missing', () => {
        const raw = '---\ntitle: "never closed"\n\nBody without closing delimiter.';
        const { frontmatter, body } = parseFrontmatter(raw);
        expect(frontmatter).toEqual({});
        expect(body).toBe(raw);
    });

    it('strips single quotes as well as double quotes', () => {
        const raw = ['---', "title: 'Single Quoted'", '---', '', 'Body.'].join('\n');
        const { frontmatter } = parseFrontmatter(raw);
        expect(frontmatter.title).toBe('Single Quoted');
    });
});

describe('obsidianHandler.parseTarget', () => {
    it('resolves the vault path to absolute and returns file_mtimes state', () => {
        const result = obsidianHandler.parseTarget(vaultDir, {});
        expect(result.id).toMatch(/^obsidian:/);
        expect((result.config as { vault_path: string }).vault_path).toBe(vaultDir);
        expect(result.initialState).toEqual({ file_mtimes: {} });
    });

    it('rejects non-existent vaults', () => {
        expect(() => obsidianHandler.parseTarget('/definitely/does/not/exist', {})).toThrow(
            /does not exist/,
        );
    });

    it('rejects paths that are files, not directories', () => {
        const filePath = join(vaultDir, 'note.md');
        writeFileSync(filePath, '# hi');
        expect(() => obsidianHandler.parseTarget(filePath, {})).toThrow(/Not a directory/);
    });

    it('accepts an optional clippings subdir when it exists', () => {
        mkdirSync(join(vaultDir, 'Clippings'));
        const result = obsidianHandler.parseTarget(vaultDir, { subdir: 'Clippings' });
        expect((result.config as { clippings_subdir: string }).clippings_subdir).toBe('Clippings');
        expect(result.id).toMatch(/:Clippings$/);
    });

    it('rejects a subdir that does not exist inside the vault', () => {
        expect(() => obsidianHandler.parseTarget(vaultDir, { subdir: 'Clippings' })).toThrow(
            /subdirectory not found/,
        );
    });

    it('rejects a subdir that escapes the vault via ..', () => {
        expect(() => obsidianHandler.parseTarget(vaultDir, { subdir: '../../etc' })).toThrow(
            /must stay inside the vault/,
        );
    });

    it('rejects an absolute-path subdir that lands outside the vault', () => {
        expect(() => obsidianHandler.parseTarget(vaultDir, { subdir: '/etc' })).toThrow(
            /must stay inside the vault/,
        );
    });
});

describe('obsidianHandler.pull', () => {
    it('picks up new clippings, promotes source URL into ExtractionResult', async () => {
        const content = clippingWithFrontmatter(
            {
                title: 'Understanding Clippers',
                source: 'https://example.com/article-1',
                author: 'Jane Doe',
                published: '2026-01-15',
                tags: ['reading', 'web'],
            },
            'The Obsidian Web Clipper saves articles as markdown with YAML frontmatter.',
        );
        writeFileSync(join(vaultDir, 'article.md'), content);
        seedConnector();

        const result = await runConnector(getConnector('obsidian:test')!);
        expect(result.error).toBeNull();
        expect(result.fetched).toBe(1);
        expect(result.ingested).toBe(1);
    });

    it('dedupes repeat clippings of the same body content on subsequent runs', async () => {
        const file = join(vaultDir, 'article.md');
        writeFileSync(
            file,
            clippingWithFrontmatter(
                { title: 'First', source: 'https://example.com/x' },
                'Repeat body content that should dedupe.',
            ),
        );
        seedConnector();
        await runConnector(getConnector('obsidian:test')!);

        /** Touch mtime so the file gets reconsidered, but body is unchanged. */
        const future = new Date(Date.now() + 5000);
        utimesSync(file, future, future);

        const second = await runConnector(getConnector('obsidian:test')!);
        expect(second.fetched).toBe(1);
        expect(second.ingested).toBe(0);
        expect(second.deduped).toBe(1);
    });

    it('skips files that have not changed since the last run', async () => {
        writeFileSync(
            join(vaultDir, 'note.md'),
            clippingWithFrontmatter(
                { title: 'Stable', source: 'https://example.com/s' },
                'Stable body with enough words to form a real chunk.',
            ),
        );
        seedConnector();
        await runConnector(getConnector('obsidian:test')!);

        const second = await runConnector(getConnector('obsidian:test')!);
        expect(second.fetched).toBe(0);
        expect(second.ingested).toBe(0);
    });

    it('skips the .obsidian metadata folder and other dotfiles', async () => {
        mkdirSync(join(vaultDir, '.obsidian'));
        writeFileSync(join(vaultDir, '.obsidian', 'config.md'), '# obsidian config\n\nIgnore me.');
        mkdirSync(join(vaultDir, '.trash'));
        writeFileSync(join(vaultDir, '.trash', 'removed.md'), '# removed\n\nIgnore me too.');
        writeFileSync(
            join(vaultDir, 'kept.md'),
            clippingWithFrontmatter(
                { title: 'Kept', source: 'https://example.com/k' },
                'The only note that should be ingested.',
            ),
        );
        seedConnector();

        const result = await runConnector(getConnector('obsidian:test')!);
        expect(result.fetched).toBe(1);
    });

    it('walks into nested subdirectories', async () => {
        mkdirSync(join(vaultDir, 'Clippings'));
        writeFileSync(
            join(vaultDir, 'Clippings', 'deep.md'),
            clippingWithFrontmatter(
                { title: 'Deep', source: 'https://example.com/d' },
                'Nested clipping body with plenty of descriptive words.',
            ),
        );
        seedConnector();

        const result = await runConnector(getConnector('obsidian:test')!);
        expect(result.fetched).toBe(1);
    });

    it('prunes state entries for markdown files that were deleted', async () => {
        const file = join(vaultDir, 'doomed.md');
        writeFileSync(
            file,
            clippingWithFrontmatter(
                { title: 'Doomed', source: 'https://example.com/doomed' },
                'About to be deleted body content.',
            ),
        );
        seedConnector();
        await runConnector(getConnector('obsidian:test')!);

        let state = JSON.parse(getConnector('obsidian:test')!.state) as {
            file_mtimes: Record<string, string>;
        };
        expect(Object.keys(state.file_mtimes)).toHaveLength(1);

        rmSync(file);
        await runConnector(getConnector('obsidian:test')!);

        state = JSON.parse(getConnector('obsidian:test')!.state) as {
            file_mtimes: Record<string, string>;
        };
        expect(Object.keys(state.file_mtimes)).toHaveLength(0);
    });

    it('records failure when the vault folder has been removed', async () => {
        seedConnector();
        rmSync(vaultDir, { recursive: true, force: true });

        const result = await runConnector(getConnector('obsidian:test')!);
        expect(result.error).toMatch(/no longer exists/);
    });

    it('handles clippings without frontmatter by using the filename for title', async () => {
        writeFileSync(
            join(vaultDir, 'plain-note.md'),
            '# Plain Note\n\nNo YAML frontmatter here, but still content.',
        );
        seedConnector();

        const result = await runConnector(getConnector('obsidian:test')!);
        expect(result.fetched).toBe(1);
        expect(result.ingested).toBe(1);
    });
});
