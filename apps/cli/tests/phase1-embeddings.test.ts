import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb, isVecAvailable } from '../src/store/database.js';
import { insertSource } from '../src/store/sources.js';
import { insertChunks } from '../src/store/chunks.js';
import { embedBatch, serializeVector } from '../src/embed/client.js';
import { embedPending, embedChunk, embeddingStats, resetVecTable } from '../src/embed/index.js';
import { searchVector } from '../src/search/vector.js';
import { contentHash, shortId } from '../src/utils/hash.js';
import type { Source, Chunk, LumenConfig, EmbeddingConfig } from '../src/types/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const NONE_CONFIG: LumenConfig = {
    data_dir: '',
    llm: {
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        api_key: null,
        base_url: null,
    },
    chunker: { min_chunk_tokens: 50, max_chunk_tokens: 500 },
    search: {
        max_results: 10,
        token_budget: 4000,
        bm25_weight: 0.35,
        tfidf_weight: 0.3,
        vector_weight: 0.35,
    },
    embedding: {
        provider: 'none',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        api_key: null,
        base_url: null,
        batch_size: 100,
    },
};

const OPENAI_CONFIG: LumenConfig = {
    ...NONE_CONFIG,
    embedding: { ...NONE_CONFIG.embedding, provider: 'openai', api_key: 'test-key-123' },
};

const OLLAMA_CONFIG: LumenConfig = {
    ...NONE_CONFIG,
    embedding: { ...NONE_CONFIG.embedding, provider: 'ollama' },
};

function makeSource(content: string): Source {
    return {
        id: shortId(content),
        title: 'Embedding Test Source',
        url: null,
        content,
        content_hash: contentHash(content),
        source_type: 'file',
        added_at: new Date().toISOString(),
        compiled_at: null,
        word_count: content.split(/\s+/).length,
        language: null,
        metadata: null,
    };
}

function makeChunk(sourceId: string, content: string, position: number): Chunk {
    return {
        id: shortId(`${sourceId}:${position}:${content}`),
        source_id: sourceId,
        content,
        content_hash: contentHash(content),
        chunk_type: 'paragraph',
        heading: null,
        position,
        token_count: Math.ceil(content.length / 4),
    };
}

/** Build a fake 1536-dim vector (all zeros except first element). */
function fakeVector(seed = 0.5): Float32Array {
    const v = new Float32Array(1536);
    v[0] = seed;
    return v;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-embed-'));
    setDataDir(tempDir);
    getDb(); // Opens DB and runs migrations (loads sqlite-vec if available)
});

afterEach(() => {
    vi.restoreAllMocks();
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

// ── serializeVector ───────────────────────────────────────────────────────────

describe('serializeVector', () => {
    it('converts Float32Array to a Buffer with the correct byte length', () => {
        const vec = fakeVector();
        const buf = serializeVector(vec);
        expect(buf).toBeInstanceOf(Buffer);
        /** Float32 = 4 bytes per element */
        expect(buf.byteLength).toBe(1536 * 4);
    });

    it('round-trips through Float32Array', () => {
        const original = new Float32Array([0.1, 0.2, 0.3]);
        const buf = serializeVector(original);
        const restored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        expect(restored[0]).toBeCloseTo(0.1, 5);
        expect(restored[1]).toBeCloseTo(0.2, 5);
        expect(restored[2]).toBeCloseTo(0.3, 5);
    });

    it('handles zero-length vector', () => {
        const buf = serializeVector(new Float32Array(0));
        expect(buf.byteLength).toBe(0);
    });
});

// ── embedBatch ────────────────────────────────────────────────────────────────

describe('embedBatch — provider validation', () => {
    it('throws when provider is "none"', async () => {
        await expect(embedBatch(['test'], NONE_CONFIG.embedding)).rejects.toThrow(
            /provider is "none"/i,
        );
    });

    it('throws when OpenAI api_key is missing', async () => {
        const cfg: EmbeddingConfig = { ...OPENAI_CONFIG.embedding, api_key: null };
        await expect(embedBatch(['test'], cfg)).rejects.toThrow(/api key/i);
    });
});

describe('embedBatch — OpenAI provider', () => {
    it('calls the OpenAI endpoint and returns Float32Arrays in input order', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
                Promise.resolve({
                    data: [
                        { index: 1, embedding: Array.from(fakeVector(0.9)) },
                        { index: 0, embedding: Array.from(fakeVector(0.1)) },
                    ],
                }),
            text: () => Promise.resolve(''),
        });
        vi.stubGlobal('fetch', mockFetch);

        const results = await embedBatch(['first', 'second'], OPENAI_CONFIG.embedding);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/v1/embeddings');
        expect(JSON.parse(opts.body as string)).toMatchObject({
            model: 'text-embedding-3-small',
            input: ['first', 'second'],
        });

        expect(results).toHaveLength(2);
        /** Results are sorted by index — index 0 should be first. */
        expect(results[0][0]).toBeCloseTo(0.1, 5);
        expect(results[1][0]).toBeCloseTo(0.9, 5);
    });

    it('throws on non-OK HTTP response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 429,
                text: () => Promise.resolve('rate limited'),
            }),
        );

        await expect(embedBatch(['test'], OPENAI_CONFIG.embedding)).rejects.toThrow(/429/);
    });

    it('honours a custom base_url', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
                Promise.resolve({ data: [{ index: 0, embedding: Array.from(fakeVector()) }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const cfg: EmbeddingConfig = {
            ...OPENAI_CONFIG.embedding,
            base_url: 'https://my-proxy.example.com',
        };
        await embedBatch(['hello'], cfg);

        expect((mockFetch.mock.calls[0] as [string])[0]).toContain('my-proxy.example.com');
    });
});

describe('embedBatch — Ollama provider', () => {
    it('makes one request per text and returns results in order', async () => {
        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ embedding: Array.from(fakeVector(callCount * 0.1)) }),
            });
        });
        vi.stubGlobal('fetch', mockFetch);

        const results = await embedBatch(['a', 'b', 'c'], OLLAMA_CONFIG.embedding);

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(results).toHaveLength(3);
        expect(results[0]).toBeInstanceOf(Float32Array);
    });
});

// ── embeddingStats ────────────────────────────────────────────────────────────

describe('embeddingStats', () => {
    it('returns zeros when the DB is empty', () => {
        const stats = embeddingStats();
        expect(stats).toEqual({ total: 0, embedded: 0, pending: 0 });
    });

    it('counts unembedded chunks as pending', () => {
        const src = makeSource('hello world content');
        insertSource(src);
        insertChunks([
            makeChunk(src.id, 'hello world content', 0),
            makeChunk(src.id, 'second chunk here', 1),
        ]);

        const stats = embeddingStats();
        expect(stats.total).toBe(2);
        expect(stats.embedded).toBe(0);
        expect(stats.pending).toBe(2);
    });

    it('pending = total − embedded', () => {
        const src = makeSource('content for stats');
        insertSource(src);
        const chunk = makeChunk(src.id, 'content for stats', 0);
        insertChunks([chunk]);

        /** Manually mark one chunk as embedded. */
        getDb()
            .prepare(`UPDATE chunks SET embedded_at = ?, embedding_model = ? WHERE id = ?`)
            .run(new Date().toISOString(), 'text-embedding-3-small', chunk.id);

        const stats = embeddingStats();
        expect(stats.total).toBe(1);
        expect(stats.embedded).toBe(1);
        expect(stats.pending).toBe(0);
    });
});

// ── embedPending (provider='none') ────────────────────────────────────────────

describe('embedPending — provider none', () => {
    it('returns 0 immediately without touching chunks', async () => {
        const src = makeSource('pending embed content');
        insertSource(src);
        insertChunks([makeChunk(src.id, 'pending embed content', 0)]);

        const count = await embedPending(NONE_CONFIG);
        expect(count).toBe(0);

        /** Chunks must remain un-embedded. */
        const stats = embeddingStats();
        expect(stats.pending).toBe(1);
    });

    it('returns 0 even when DB is empty', async () => {
        const count = await embedPending(NONE_CONFIG);
        expect(count).toBe(0);
    });
});

// ── embedChunk (provider='none') ──────────────────────────────────────────────

describe('embedChunk — provider none', () => {
    it('is a no-op and does not mark the chunk as embedded', async () => {
        const src = makeSource('single chunk source');
        insertSource(src);
        const chunk = makeChunk(src.id, 'single chunk source', 0);
        insertChunks([chunk]);

        await embedChunk(chunk.id, chunk.content, NONE_CONFIG);

        const row = getDb()
            .prepare('SELECT embedded_at FROM chunks WHERE id = ?')
            .get(chunk.id) as { embedded_at: string | null };
        expect(row.embedded_at).toBeNull();
    });
});

// ── searchVector (provider='none') ────────────────────────────────────────────

describe('searchVector — provider none', () => {
    it('returns an empty array without throwing', async () => {
        const results = await searchVector('any query', NONE_CONFIG, 10);
        expect(results).toEqual([]);
    });
});

// ── resetVecTable (requires sqlite-vec) ───────────────────────────────────────

describe('resetVecTable', () => {
    it.skipIf(!isVecAvailable())(
        'drops and recreates vec_chunks and marks all chunks un-embedded',
        () => {
            const src = makeSource('vec table reset content');
            insertSource(src);
            const chunk = makeChunk(src.id, 'vec table reset content', 0);
            insertChunks([chunk]);

            /** Manually mark it embedded. */
            getDb()
                .prepare(`UPDATE chunks SET embedded_at = ?, embedding_model = ? WHERE id = ?`)
                .run(new Date().toISOString(), 'text-embedding-3-small', chunk.id);

            expect(embeddingStats().embedded).toBe(1);

            resetVecTable(768); // Switch to hypothetical 768-dim model

            /** All chunks must now be pending. */
            const stats = embeddingStats();
            expect(stats.embedded).toBe(0);
            expect(stats.pending).toBe(1);

            /** vec_chunks must exist with the new schema. */
            const tables = getDb()
                .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'`)
                .all();
            expect(tables).toHaveLength(1);
        },
    );

    it('is a no-op when sqlite-vec is unavailable', () => {
        if (isVecAvailable()) return; // Only meaningful when vec is absent
        expect(() => resetVecTable(1536)).not.toThrow();
    });
});
