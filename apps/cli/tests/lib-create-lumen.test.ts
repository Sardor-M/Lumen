import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLumen, LumenError, LumenNotInitializedError } from '../src/index.js';
import { resetDataDir } from '../src/utils/paths.js';
import { closeDb } from '../src/store/database.js';
import { insertSource } from '../src/store/sources.js';
import { insertChunks } from '../src/store/chunks.js';
import { contentHash, shortId } from '../src/utils/hash.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-lib-'));
});

afterEach(() => {
    /** Close the SQLite handle BEFORE removing the file. `closeDb()` is a
     *  no-op if no DB is open, so safe even when a test never opened one. */
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
});

describe('createLumen — factory', () => {
    it('throws LumenNotInitializedError when workspace is missing and autoInit=false', () => {
        const lumen = createLumen({ dataDir: workDir });
        expect(() => lumen.status()).toThrow(LumenNotInitializedError);
    });

    it('autoInit creates the workspace and opens the DB', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const s = lumen.status();
        expect(s.sources).toBe(0);
        expect(s.chunks).toBe(0);
        expect(s.data_dir).toBe(workDir);
        lumen.close();
    });

    it('dataDir() reflects the active workspace', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status(); // open
        expect(lumen.dataDir()).toBe(workDir);
        lumen.close();
    });

    it('rejects empty dataDir', () => {
        expect(() => createLumen({ dataDir: '   ', autoInit: true })).toThrow(/non-empty string/);
    });

    it('close() is idempotent', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        lumen.close();
        expect(() => lumen.close()).not.toThrow();
    });
});

describe('createLumen — status', () => {
    it('reflects seeded sources and chunks', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status(); // force open

        const content = 'The transformer architecture introduced self-attention mechanisms.';
        const id = shortId(content);
        insertSource({
            id,
            title: 'Attention Is All You Need',
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

        const s = lumen.status();
        expect(s.sources).toBe(1);
        expect(s.chunks).toBe(1);
        expect(s.sources_by_type).toEqual({ url: 1 });
        expect(s.db_bytes).toBeGreaterThan(0);
        lumen.close();
    });
});

describe('createLumen — search', () => {
    function seed(title: string, content: string): string {
        const id = shortId(content);
        insertSource({
            id,
            title,
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
                token_count: content.split(/\s+/).length,
            },
        ]);
        return id;
    }

    it('returns resolved hits with title, content, and rank', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();

        seed(
            'Transformers',
            'Self-attention allows the model to weigh token relationships across a sequence.',
        );
        seed('CNNs', 'Convolutional networks apply shared kernels to spatial inputs for vision.');

        const results = lumen.search({ query: 'attention', limit: 5 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].source_title).toBe('Transformers');
        expect(results[0].content).toMatch(/attention/i);
        expect(results[0].rank).toBe(1);
        lumen.close();
    });

    it('validates empty query', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        expect(() => lumen.search({ query: '' })).toThrow(/non-empty/);
        lumen.close();
    });

    it('bm25 mode skips TF-IDF', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        seed('Test', 'The quick brown fox jumps over the lazy dog repeatedly.');
        const results = lumen.search({ query: 'quick fox', mode: 'bm25', limit: 3 });
        expect(results.length).toBeGreaterThanOrEqual(1);
        lumen.close();
    });
});

describe('createLumen — graph namespace', () => {
    it('returns empty godNodes on a fresh workspace', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(lumen.graph.godNodes()).toEqual([]);
        lumen.close();
    });

    it('validates path() slugs', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.status();
        expect(() => lumen.graph.path('', 'x')).toThrow(/non-empty/);
        lumen.close();
    });
});

describe('createLumen — profile', () => {
    it('returns a profile shape for an empty workspace', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const p = lumen.profile();
        expect(p.static.total_sources).toBe(0);
        expect(p.static.total_concepts).toBe(0);
        expect(p.static.graph_density).toBe(0);
        lumen.close();
    });
});

describe('createLumen — watch namespace', () => {
    it('adds, lists, gets, and removes an RSS connector', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const added = lumen.watch.add({
            type: 'rss',
            target: 'https://simonwillison.net/atom/everything/',
            interval: 3600,
            name: 'Simon W',
        });
        expect(added.type).toBe('rss');
        expect(added.id).toMatch(/^rss:/);
        expect(added.name).toBe('Simon W');

        const list = lumen.watch.list();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(added.id);

        const got = lumen.watch.get(added.id);
        expect(got?.id).toBe(added.id);

        const removed = lumen.watch.remove(added.id);
        expect(removed).toBe(true);
        expect(lumen.watch.list()).toHaveLength(0);
        lumen.close();
    });

    it('rejects unknown types and invalid intervals', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        expect(() => lumen.watch.add({ type: 'bogus', target: 'x' })).toThrow(/Unknown connector/);
        expect(() =>
            lumen.watch.add({
                type: 'rss',
                target: 'https://example.com/feed',
                interval: 1,
            }),
        ).toThrow(/between/);
        expect(() => lumen.watch.add({ type: 'rss', target: '' })).toThrow(/target/);
        lumen.close();
    });

    it('rejects duplicate connector IDs', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        lumen.watch.add({
            type: 'rss',
            target: 'https://simonwillison.net/atom/everything/',
        });
        expect(() =>
            lumen.watch.add({
                type: 'rss',
                target: 'https://simonwillison.net/atom/everything/',
            }),
        ).toThrow(/already exists/);
        lumen.close();
    });

    it('handlerTypes returns the registered set', () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const types = lumen.watch.handlerTypes();
        expect(types).toEqual(
            expect.arrayContaining(['rss', 'folder', 'arxiv', 'github', 'youtube-channel']),
        );
        lumen.close();
    });
});

describe('createLumen — ask / compile config guards', () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenRouter = process.env.OPENROUTER_API_KEY;

    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
    });
    afterEach(() => {
        if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
        if (savedOpenRouter) process.env.OPENROUTER_API_KEY = savedOpenRouter;
    });

    it('ask() throws LumenError when no API key is configured', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(lumen.ask({ question: 'what is attention?' })).rejects.toThrow(
            /No LLM API key/,
        );
        lumen.close();
    });

    it('ask() validates empty question', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(lumen.ask({ question: '' })).rejects.toThrow(/non-empty/);
        lumen.close();
    });

    it('compile() throws LumenError when no API key is configured', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(lumen.compile()).rejects.toThrow(/No LLM API key/);
        lumen.close();
    });
});

describe('createLumen — add', () => {
    function writeFixture(name: string, content: string): string {
        const path = join(workDir, name);
        writeFileSync(path, content, 'utf-8');
        return path;
    }

    it('ingests a local markdown file and reports chunks + word count', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'attention.md',
            [
                '# Attention Is All You Need',
                '',
                'Self-attention is the cornerstone of the transformer architecture.',
                'It enables the model to weigh relationships between all tokens in a sequence',
                'without relying on recurrence or convolution.',
            ].join('\n'),
        );

        const result = await lumen.add(path);
        expect(result.status).toBe('added');
        if (result.status !== 'added') throw new Error('unreachable');

        expect(result.source_type).toBe('file');
        expect(result.chunks).toBeGreaterThanOrEqual(1);
        expect(result.words).toBeGreaterThan(5);
        expect(result.title).toMatch(/attention/i);

        const s = lumen.status();
        expect(s.sources).toBe(1);
        expect(s.chunks).toBe(result.chunks);
        lumen.close();
    });

    it('dedupes identical content on a second add', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'note.md',
            'The cat sat on the mat. This is deduplication bait across the corpus.',
        );

        const first = await lumen.add(path);
        expect(first.status).toBe('added');
        if (first.status !== 'added') throw new Error('unreachable');

        const second = await lumen.add(path);
        expect(second.status).toBe('skipped');
        if (second.status !== 'skipped') throw new Error('unreachable');

        expect(second.reason).toBe('duplicate');
        expect(second.id).toBe(first.id);
        expect(lumen.status().sources).toBe(1);
        lumen.close();
    });

    it('accepts the object form `{ input }`', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const path = writeFixture(
            'obj.md',
            'Object form input. Ensures the alternative signature keeps working for consumers.',
        );

        const result = await lumen.add({ input: path });
        expect(result.status).toBe('added');
        lumen.close();
    });

    it('throws LumenError on empty input', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        await expect(lumen.add('')).rejects.toThrow(LumenError);
        await expect(lumen.add({ input: '   ' })).rejects.toThrow(LumenError);
        lumen.close();
    });

    it('invalidates the profile cache after a successful add', async () => {
        const lumen = createLumen({ dataDir: workDir, autoInit: true });
        const before = lumen.profile();
        expect(before.static.total_sources).toBe(0);

        const path = writeFixture(
            'fresh.md',
            'Fresh source content that should make the next profile rebuild reflect +1 source.',
        );
        await lumen.add(path);

        const after = lumen.profile();
        expect(after.static.total_sources).toBe(1);
        lumen.close();
    });
});
