import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertConnector, getConnector } from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler } from '../src/connectors/registry.js';
import { folderHandler } from '../src/connectors/handlers/folder.js';
import type { Connector } from '../src/types/index.js';

let lumenDir: string;
let watchDir: string;

beforeEach(() => {
    lumenDir = mkdtempSync(join(tmpdir(), 'lumen-folder-'));
    watchDir = mkdtempSync(join(tmpdir(), 'lumen-watchdir-'));
    setDataDir(lumenDir);
    getDb();
    registerHandler(folderHandler);
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(lumenDir, { recursive: true, force: true });
    if (existsSync(watchDir)) rmSync(watchDir, { recursive: true, force: true });
});

function seedConnector(overrides: Partial<Connector> = {}): Connector {
    const c: Connector = {
        id: 'folder:test',
        type: 'folder',
        name: 'test',
        config: JSON.stringify({ path: watchDir }),
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

describe('folderHandler.parseTarget', () => {
    it('resolves relative paths to absolute', () => {
        const result = folderHandler.parseTarget(watchDir, {});
        expect(result.id).toMatch(/^folder:/);
        expect((result.config as { path: string }).path).toBe(watchDir);
        expect(result.initialState).toEqual({ file_mtimes: {} });
    });

    it('rejects non-existent folders', () => {
        expect(() => folderHandler.parseTarget('/definitely/does/not/exist/xyz', {})).toThrow(
            /does not exist/,
        );
    });

    it('rejects paths that are not directories', () => {
        const filePath = join(watchDir, 'a-file.md');
        writeFileSync(filePath, '# hi\n');
        expect(() => folderHandler.parseTarget(filePath, {})).toThrow(/Not a directory/);
    });
});

describe('folderHandler.pull', () => {
    it('picks up new text files on first run, records mtimes in state', async () => {
        writeFileSync(join(watchDir, 'a.md'), '# Alpha\n\nAlpha body with several words.');
        writeFileSync(
            join(watchDir, 'b.txt'),
            'Beta body with enough words to be a real chunk of text content.',
        );
        seedConnector();

        const result = await runConnector(getConnector('folder:test')!);
        expect(result.error).toBeNull();
        expect(result.fetched).toBe(2);
        expect(result.ingested).toBe(2);

        const state = JSON.parse(getConnector('folder:test')!.state) as {
            file_mtimes: Record<string, string>;
        };
        expect(Object.keys(state.file_mtimes)).toHaveLength(2);
    });

    it('skips unchanged files on second run', async () => {
        writeFileSync(join(watchDir, 'a.md'), '# Alpha\n\nAlpha body with several words.');
        seedConnector();
        await runConnector(getConnector('folder:test')!);

        const second = await runConnector(getConnector('folder:test')!);
        expect(second.fetched).toBe(0);
        expect(second.ingested).toBe(0);
    });

    it('re-ingests a file when mtime advances', async () => {
        const filePath = join(watchDir, 'a.md');
        writeFileSync(filePath, '# Alpha\n\nFirst version with plenty of text content.');
        seedConnector();
        await runConnector(getConnector('folder:test')!);

        /** Bump mtime forward; content changes so runner should see a new hash too. */
        writeFileSync(filePath, '# Alpha\n\nSecond version with completely different text.');
        const future = new Date(Date.now() + 5000);
        utimesSync(filePath, future, future);

        const second = await runConnector(getConnector('folder:test')!);
        expect(second.fetched).toBe(1);
        expect(second.ingested).toBe(1);
    });

    it('ignores unsupported extensions', async () => {
        writeFileSync(join(watchDir, 'note.md'), '# Note\n\nMarkdown body with enough words.');
        writeFileSync(join(watchDir, 'image.png'), 'not really an image');
        writeFileSync(join(watchDir, 'config.yaml'), 'key: value');
        seedConnector();

        const result = await runConnector(getConnector('folder:test')!);
        expect(result.fetched).toBe(1);
    });

    it('recurses into subdirectories but skips dotfiles and node_modules', async () => {
        mkdirSync(join(watchDir, 'sub'));
        mkdirSync(join(watchDir, 'node_modules'));
        mkdirSync(join(watchDir, '.hidden'));
        writeFileSync(join(watchDir, 'sub', 'nested.md'), '# Nested\n\nNested body text.');
        writeFileSync(
            join(watchDir, 'node_modules', 'pkg.md'),
            '# Should be ignored\n\nIgnored text.',
        );
        writeFileSync(join(watchDir, '.hidden', 'secret.md'), '# Also ignored\n\nHidden dir text.');
        seedConnector();

        const result = await runConnector(getConnector('folder:test')!);
        expect(result.fetched).toBe(1);
    });

    it('prunes state entries for files that were deleted', async () => {
        const filePath = join(watchDir, 'will-be-deleted.md');
        writeFileSync(filePath, '# Doomed\n\nSoon to be removed body text.');
        seedConnector();
        await runConnector(getConnector('folder:test')!);

        let state = JSON.parse(getConnector('folder:test')!.state) as {
            file_mtimes: Record<string, string>;
        };
        expect(Object.keys(state.file_mtimes)).toHaveLength(1);

        rmSync(filePath);
        await runConnector(getConnector('folder:test')!);

        state = JSON.parse(getConnector('folder:test')!.state) as {
            file_mtimes: Record<string, string>;
        };
        expect(Object.keys(state.file_mtimes)).toHaveLength(0);
    });

    it('records failure when watched folder has been removed entirely', async () => {
        seedConnector();
        rmSync(watchDir, { recursive: true, force: true });

        const result = await runConnector(getConnector('folder:test')!);
        expect(result.error).toMatch(/no longer exists/);
    });
});
