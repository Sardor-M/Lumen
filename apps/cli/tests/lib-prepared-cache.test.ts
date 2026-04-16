import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, closeDb } from '../src/store/database.js';
import { getStmt } from '../src/store/prepared.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-stmtcache-'));
    setDataDir(workDir);
    getDb();
});

afterEach(() => {
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
});

describe('getStmt — caching', () => {
    it('returns the same Statement instance for identical SQL', () => {
        const db = getDb();
        const a = getStmt(db, 'SELECT 1');
        const b = getStmt(db, 'SELECT 1');
        expect(a).toBe(b);
    });

    it('returns distinct statements for distinct SQL', () => {
        const db = getDb();
        const a = getStmt(db, 'SELECT 1');
        const b = getStmt(db, 'SELECT 2');
        expect(a).not.toBe(b);
    });

    it('calls db.prepare exactly once per unique SQL across many lookups', () => {
        const db = getDb();
        const spy = vi.spyOn(db, 'prepare');
        for (let i = 0; i < 50; i++) {
            getStmt(db, 'SELECT COUNT(*) FROM sources');
        }
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

describe('getStmt — cache isolation across reopens', () => {
    it('dropping the cache (via closeDb) yields fresh statements on reopen', () => {
        const firstDb = getDb();
        const firstStmt = getStmt(firstDb, 'SELECT 1');

        closeDb();
        setDataDir(workDir); // ensure path resolves post-reset
        const secondDb = getDb();
        const secondStmt = getStmt(secondDb, 'SELECT 1');

        /** Different handles AND different statement instances. */
        expect(secondDb).not.toBe(firstDb);
        expect(secondStmt).not.toBe(firstStmt);
    });
});

describe('getStmt — end-to-end via search()', () => {
    /** Smoke test: two `search()` calls should share the same prepared
     *  statements for the resolve step. This is more a correctness check
     *  than a perf assertion — we confirm nothing broke after the swap. */
    it('repeated search() calls still return consistent shapes', async () => {
        const { createLumen } = await import('../src/index.js');
        closeDb();

        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const { insertSource } = await import('../src/store/sources.js');
        const { insertChunks } = await import('../src/store/chunks.js');
        const { shortId, contentHash } = await import('../src/utils/hash.js');

        const content = 'Prepared-statement cache smoke test content here.';
        const id = shortId(content);
        insertSource({
            id,
            title: 'Smoke',
            url: null,
            content,
            content_hash: contentHash(content),
            source_type: 'url',
            added_at: new Date().toISOString(),
            compiled_at: null,
            word_count: content.split(/\s+/).length,
            language: null,
            metadata: null,
        });
        insertChunks([
            {
                id: `${id}:0`,
                source_id: id,
                content,
                content_hash: contentHash(content),
                chunk_type: 'paragraph',
                heading: null,
                position: 0,
                token_count: 10,
            },
        ]);

        const first = lumen.search({ query: 'cache' });
        const second = lumen.search({ query: 'cache' });
        expect(first).toEqual(second);
        expect(first.length).toBeGreaterThan(0);
        lumen.close();
    });
});
