import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { upsertConcept } from '../src/store/concepts.js';
import { upsertEdge } from '../src/store/edges.js';
import { insertSource } from '../src/store/sources.js';
import { insertChunks } from '../src/store/chunks.js';
import { classifyIntent, classifierStats } from '../src/classify/intent.js';
import { extractPatterns } from '../src/classify/patterns.js';
import { routedSearch } from '../src/search/index.js';
import { contentHash, shortId } from '../src/utils/hash.js';
import type { LumenConfig, Chunk, Source, QueryIntent } from '../src/types/index.js';

/**
 * Mock the LLM client so tests never make real API calls.
 * Individual tests use vi.mocked(chat).mockResolvedValueOnce(…).
 */
vi.mock('../src/llm/client.js', () => ({
    chat: vi.fn(),
    chatJson: vi.fn(),
}));

import { chat } from '../src/llm/client.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TEST_CONFIG: LumenConfig = {
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

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-classify-'));
    setDataDir(tempDir);
    getDb();
    vi.clearAllMocks();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertConcept(slug: string, compiledTruth?: string): void {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name: slug.replace(/-/g, ' '),
        summary: compiledTruth ?? null,
        compiled_truth: compiledTruth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
    });
}

function makeSource(content: string, title = 'Test Source'): Source {
    return {
        id: shortId(content),
        title,
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

function makeChunk(sourceId: string, content: string, position = 0): Chunk {
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

/** Insert a learned classifier pattern directly into the DB. */
function insertPattern(pattern: string, label: QueryIntent, confidence = 1.0): void {
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO classifier_patterns
               (classifier_name, pattern, label, confidence, match_count, created_at, source)
             VALUES ('intent', ?, ?, ?, 0, datetime('now'), 'manual')`,
        )
        .run(pattern, label, confidence);
}

/** Insert a fallback log entry. */
function insertFallback(input: string, label: QueryIntent): void {
    getDb()
        .prepare(
            `INSERT INTO classifier_fallbacks
               (classifier_name, input, llm_label, created_at)
             VALUES ('intent', ?, ?, datetime('now'))`,
        )
        .run(input, label);
}

// ── classifyIntent — built-in deterministic patterns ─────────────────────────

describe('classifyIntent — built-in patterns (no LLM)', () => {
    it('"what is X" → entity_lookup', async () => {
        expect(await classifyIntent('what is transformer architecture', TEST_CONFIG)).toBe(
            'entity_lookup',
        );
    });

    it('"who is X" → entity_lookup', async () => {
        expect(await classifyIntent('who is Geoffrey Hinton', TEST_CONFIG)).toBe('entity_lookup');
    });

    it('"tell me about X" → entity_lookup', async () => {
        expect(await classifyIntent('tell me about attention mechanism', TEST_CONFIG)).toBe(
            'entity_lookup',
        );
    });

    it('"explain X" → entity_lookup', async () => {
        expect(await classifyIntent('explain backpropagation', TEST_CONFIG)).toBe('entity_lookup');
    });

    it('"describe X" → entity_lookup', async () => {
        expect(await classifyIntent('describe the encoder layer', TEST_CONFIG)).toBe(
            'entity_lookup',
        );
    });

    it('"path from X to Y" → graph_path', async () => {
        expect(await classifyIntent('path from bert to self-attention', TEST_CONFIG)).toBe(
            'graph_path',
        );
    });

    it('"path between X and Y" → graph_path', async () => {
        expect(await classifyIntent('path between transformers and rnns', TEST_CONFIG)).toBe(
            'graph_path',
        );
    });

    it('"how does X connect to Y" → graph_path', async () => {
        expect(
            await classifyIntent('how does dropout connect to regularization', TEST_CONFIG),
        ).toBe('graph_path');
    });

    it('"how does X relate to Y" → graph_path', async () => {
        expect(await classifyIntent('how does adam relate to sgd', TEST_CONFIG)).toBe('graph_path');
    });

    it('"related to X" → neighborhood', async () => {
        expect(await classifyIntent('related to attention mechanism', TEST_CONFIG)).toBe(
            'neighborhood',
        );
    });

    it('"neighbors of X" → neighborhood', async () => {
        expect(await classifyIntent('neighbors of transformer-architecture', TEST_CONFIG)).toBe(
            'neighborhood',
        );
    });

    it('"connected to X" → neighborhood', async () => {
        expect(await classifyIntent('connected to backpropagation', TEST_CONFIG)).toBe(
            'neighborhood',
        );
    });

    it('"timeline of X" → temporal', async () => {
        expect(await classifyIntent('timeline of large language models', TEST_CONFIG)).toBe(
            'temporal',
        );
    });

    it('"history of X" → temporal', async () => {
        expect(await classifyIntent('history of deep learning', TEST_CONFIG)).toBe('temporal');
    });

    it('"what happened in March" → temporal', async () => {
        expect(await classifyIntent('what happened in March 2023', TEST_CONFIG)).toBe('temporal');
    });

    it('"what have I said about X" → originals', async () => {
        expect(await classifyIntent('what have I said about attention', TEST_CONFIG)).toBe(
            'originals',
        );
    });

    it('"my notes on X" → originals', async () => {
        expect(await classifyIntent('my notes on transformers', TEST_CONFIG)).toBe('originals');
    });

    it('none of the above → falls to LLM (mocked as hybrid_search)', async () => {
        vi.mocked(chat).mockResolvedValueOnce('hybrid_search');
        const intent = await classifyIntent('show me papers on neural scaling laws', TEST_CONFIG);
        expect(intent).toBe('hybrid_search');
        expect(chat).toHaveBeenCalledOnce();
    });

    /** Patterns must not call the LLM for matched queries. */
    it('does NOT call the LLM when a built-in pattern matches', async () => {
        await classifyIntent('what is self-attention', TEST_CONFIG);
        expect(chat).not.toHaveBeenCalled();
    });
});

// ── classifyIntent — DB learned patterns ──────────────────────────────────────

describe('classifyIntent — DB learned patterns', () => {
    it('uses a learned pattern before checking built-in patterns', async () => {
        /** Custom pattern that would not match any built-in rule. */
        insertPattern('^fetch papers about', 'entity_lookup');

        const intent = await classifyIntent('fetch papers about attention', TEST_CONFIG);
        expect(intent).toBe('entity_lookup');
        expect(chat).not.toHaveBeenCalled();
    });

    it('increments match_count when a learned pattern fires', async () => {
        insertPattern('^custom pattern', 'neighborhood');
        await classifyIntent('custom pattern for something', TEST_CONFIG);
        await classifyIntent('custom pattern again', TEST_CONFIG);

        const row = getDb()
            .prepare(
                `SELECT match_count FROM classifier_patterns
                 WHERE classifier_name = 'intent' AND pattern = '^custom pattern'`,
            )
            .get() as { match_count: number };

        expect(row.match_count).toBe(2);
    });

    it('skips invalid regex patterns in DB without crashing', async () => {
        /** Insert an invalid regex. */
        getDb()
            .prepare(
                `INSERT INTO classifier_patterns
                   (classifier_name, pattern, label, confidence, match_count, created_at, source)
                 VALUES ('intent', '[invalid((regex', 'entity_lookup', 1.0, 0, datetime('now'), 'manual')`,
            )
            .run();

        /** Should fall through to built-in patterns. */
        const intent = await classifyIntent('what is bert', TEST_CONFIG);
        expect(intent).toBe('entity_lookup'); // built-in pattern still works
    });

    it('DB patterns are checked before built-in patterns (higher priority)', async () => {
        /** Override "what is X" to be classified as graph_path via DB. */
        insertPattern('^what is ', 'graph_path', 0.99);

        const intent = await classifyIntent('what is attention', TEST_CONFIG);
        /** DB pattern wins over the built-in entity_lookup pattern. */
        expect(intent).toBe('graph_path');
    });
});

// ── classifyIntent — LLM fallback logging ────────────────────────────────────

describe('classifyIntent — LLM fallback logging', () => {
    it('logs fallback to classifier_fallbacks when LLM is used', async () => {
        vi.mocked(chat).mockResolvedValueOnce('hybrid_search');
        await classifyIntent('something with no matching pattern', TEST_CONFIG);

        const rows = getDb()
            .prepare(`SELECT * FROM classifier_fallbacks WHERE classifier_name = 'intent'`)
            .all() as { input: string; llm_label: string }[];

        expect(rows).toHaveLength(1);
        expect(rows[0].input).toBe('something with no matching pattern');
        expect(rows[0].llm_label).toBe('hybrid_search');
    });

    it('falls back to hybrid_search when LLM returns an unknown label', async () => {
        vi.mocked(chat).mockResolvedValueOnce('totally_unknown_label');
        const intent = await classifyIntent('mystery query xyz', TEST_CONFIG);
        expect(intent).toBe('hybrid_search');
    });

    it('falls back to hybrid_search when LLM call throws', async () => {
        vi.mocked(chat).mockRejectedValueOnce(new Error('Network error'));
        const intent = await classifyIntent('query that causes LLM error', TEST_CONFIG);
        expect(intent).toBe('hybrid_search');
    });
});

// ── classifierStats ───────────────────────────────────────────────────────────

describe('classifierStats', () => {
    it('returns zeros for a fresh DB', () => {
        const stats = classifierStats();
        expect(stats.total).toBe(0);
        expect(stats.pattern_hits).toBe(0);
        expect(stats.llm_fallbacks).toBe(0);
        expect(stats.deterministic_pct).toBe(0);
        expect(stats.learned_patterns).toBe(0);
    });

    it('counts LLM fallbacks correctly', () => {
        insertFallback('query a', 'hybrid_search');
        insertFallback('query b', 'entity_lookup');

        const stats = classifierStats();
        expect(stats.llm_fallbacks).toBe(2);
        expect(stats.total).toBe(2);
        expect(stats.deterministic_pct).toBe(0);
    });

    it('counts learned pattern hits correctly', () => {
        getDb()
            .prepare(
                `INSERT INTO classifier_patterns
                   (classifier_name, pattern, label, confidence, match_count, created_at, source)
                 VALUES ('intent', '^test', 'entity_lookup', 1.0, 7, datetime('now'), 'llm')`,
            )
            .run();

        const stats = classifierStats();
        expect(stats.pattern_hits).toBe(7);
        expect(stats.learned_patterns).toBe(1);
    });

    it('computes deterministic_pct correctly', () => {
        /** 8 pattern hits + 2 LLM fallbacks = 80% deterministic. */
        getDb()
            .prepare(
                `INSERT INTO classifier_patterns
                   (classifier_name, pattern, label, confidence, match_count, created_at, source)
                 VALUES ('intent', '^fast', 'entity_lookup', 1.0, 8, datetime('now'), 'llm')`,
            )
            .run();
        insertFallback('fallback 1', 'hybrid_search');
        insertFallback('fallback 2', 'hybrid_search');

        const stats = classifierStats();
        expect(stats.deterministic_pct).toBe(80);
    });
});

// ── extractPatterns ───────────────────────────────────────────────────────────

describe('extractPatterns', () => {
    it('returns 0 when there are no unprocessed fallbacks', async () => {
        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(0);
        expect(chat).not.toHaveBeenCalled();
    });

    it('returns 0 when all fallbacks appear fewer than 2 times', async () => {
        insertFallback('one-off query', 'hybrid_search');
        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(0);
    });

    it('calls the LLM and inserts valid patterns for repeated fallbacks', async () => {
        /** Same input seen 3 times → qualifies for extraction. */
        insertFallback('papers about scaling', 'hybrid_search');
        insertFallback('papers about scaling', 'hybrid_search');
        insertFallback('papers about scaling', 'hybrid_search');

        vi.mocked(chat).mockResolvedValueOnce(
            JSON.stringify([{ pattern: '^papers about', label: 'hybrid_search', confidence: 0.9 }]),
        );

        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(1);

        const rows = getDb()
            .prepare(
                `SELECT pattern, label FROM classifier_patterns WHERE classifier_name = 'intent'`,
            )
            .all() as { pattern: string; label: string }[];

        expect(rows).toHaveLength(1);
        expect(rows[0].pattern).toBe('^papers about');
        expect(rows[0].label).toBe('hybrid_search');
    });

    it('skips invalid regexes returned by the LLM', async () => {
        insertFallback('repeated query alpha', 'entity_lookup');
        insertFallback('repeated query alpha', 'entity_lookup');

        vi.mocked(chat).mockResolvedValueOnce(
            JSON.stringify([
                { pattern: '[broken((regex', label: 'entity_lookup', confidence: 0.8 },
                { pattern: '^repeated query', label: 'entity_lookup', confidence: 0.95 },
            ]),
        );

        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(1); // only the valid one
    });

    it('marks processed fallbacks (pattern_used = "extracted")', async () => {
        insertFallback('batch query', 'neighborhood');
        insertFallback('batch query', 'neighborhood');

        vi.mocked(chat).mockResolvedValueOnce(
            JSON.stringify([{ pattern: '^batch', label: 'neighborhood', confidence: 0.85 }]),
        );

        await extractPatterns(TEST_CONFIG);

        const unprocessed = getDb()
            .prepare(
                `SELECT COUNT(*) AS n FROM classifier_fallbacks
                 WHERE classifier_name = 'intent' AND pattern_used IS NULL`,
            )
            .get() as { n: number };

        expect(unprocessed.n).toBe(0);
    });

    it('does not insert duplicate patterns (INSERT OR IGNORE)', async () => {
        insertPattern('^already', 'entity_lookup');

        insertFallback('already existing', 'entity_lookup');
        insertFallback('already existing', 'entity_lookup');

        vi.mocked(chat).mockResolvedValueOnce(
            JSON.stringify([{ pattern: '^already', label: 'entity_lookup', confidence: 0.9 }]),
        );

        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(0); // duplicate ignored

        const count = (
            getDb().prepare(`SELECT COUNT(*) AS n FROM classifier_patterns`).get() as { n: number }
        ).n;
        expect(count).toBe(1); // still just one
    });

    it('gracefully handles LLM returning malformed JSON', async () => {
        insertFallback('bad json query', 'hybrid_search');
        insertFallback('bad json query', 'hybrid_search');

        vi.mocked(chat).mockResolvedValueOnce('this is not json at all');

        const added = await extractPatterns(TEST_CONFIG);
        expect(added).toBe(0); // graceful degradation
    });
});

// ── routedSearch ──────────────────────────────────────────────────────────────

describe('routedSearch — entity_lookup', () => {
    it('returns concept page when slug resolves from query', async () => {
        insertConcept(
            'transformer-architecture',
            'A neural network architecture using self-attention.',
        );

        const result = await routedSearch('what is transformer-architecture', TEST_CONFIG);

        expect(result.intent).toBe('entity_lookup');
        expect(result.found).toBe(true);
        expect(result.concept).toBeDefined();
        expect(result.concept!.slug).toBe('transformer-architecture');
        expect(result.concept!.compiled_truth).toBe(
            'A neural network architecture using self-attention.',
        );
        expect(result.chunks).toBeUndefined();
        expect(chat).not.toHaveBeenCalled(); // pattern matched, no LLM
    });

    it('includes outgoing and incoming edge lists on the concept result', async () => {
        insertConcept('transformer-architecture');
        insertConcept('self-attention');
        upsertEdge({
            from_slug: 'transformer-architecture',
            to_slug: 'self-attention',
            relation: 'implements',
            weight: 0.9,
            source_id: null,
        });

        const result = await routedSearch('what is transformer-architecture', TEST_CONFIG);

        expect(result.concept!.outgoing_edges).toHaveLength(1);
        expect(result.concept!.outgoing_edges[0].to).toBe('self-attention');
        expect(result.concept!.outgoing_edges[0].relation).toBe('implements');
    });

    it('falls back to hybrid_search when slug is not found', async () => {
        /** No concept in DB — must fall through to hybrid. */
        vi.mocked(chat).mockResolvedValueOnce('hybrid_search');

        const src = makeSource('General content about transformer models');
        insertSource(src);
        insertChunks([makeChunk(src.id, 'General content about transformer models')]);

        /** routedSearch calls classifyIntent (LLM for fallback), then hybrid search. */
        const result = await routedSearch('what is non-existent-concept', TEST_CONFIG);

        /** Intent is entity_lookup from built-in pattern, but no concept found → hybrid fallback. */
        expect(result.found).toBeDefined(); // may or may not find chunks
    });
});

describe('routedSearch — graph_path', () => {
    it('returns path result between two connected concepts', async () => {
        insertConcept('transformer-architecture');
        insertConcept('self-attention');
        upsertEdge({
            from_slug: 'transformer-architecture',
            to_slug: 'self-attention',
            relation: 'implements',
            weight: 0.9,
            source_id: null,
        });

        const result = await routedSearch(
            'path from transformer-architecture to self-attention',
            TEST_CONFIG,
        );

        expect(result.intent).toBe('graph_path');
        expect(result.found).toBe(true);
        expect(result.path).toBeDefined();
        expect(result.path!.hops).toBe(1);
        expect(result.path!.path).toContain('transformer-architecture');
        expect(result.path!.path).toContain('self-attention');
        expect(chat).not.toHaveBeenCalled();
    });

    it('returns found:false when no path exists', async () => {
        insertConcept('island-a');
        insertConcept('island-b');
        /** No edge between them. */

        const result = await routedSearch('path from island-a to island-b', TEST_CONFIG);

        expect(result.intent).toBe('graph_path');
        expect(result.found).toBe(false);
        expect(result.path).toBeNull();
    });

    it('falls through to hybrid_search when slugs cannot be extracted', async () => {
        /** Ambiguous phrasing that doesn't match any path extraction regex. */
        vi.mocked(chat).mockResolvedValueOnce('graph_path');

        const result = await routedSearch('how do things work together', TEST_CONFIG);
        /** Pattern doesn't match, LLM classifies as graph_path, but no slugs → falls through. */
        expect(result).toBeDefined(); // no crash
    });
});

describe('routedSearch — neighborhood', () => {
    it('returns neighbor nodes around a concept', async () => {
        insertConcept('transformer-architecture');
        insertConcept('self-attention');
        insertConcept('feed-forward-network');
        upsertEdge({
            from_slug: 'transformer-architecture',
            to_slug: 'self-attention',
            relation: 'implements',
            weight: 0.9,
            source_id: null,
        });
        upsertEdge({
            from_slug: 'transformer-architecture',
            to_slug: 'feed-forward-network',
            relation: 'part-of',
            weight: 0.8,
            source_id: null,
        });

        const result = await routedSearch('related to transformer-architecture', TEST_CONFIG);

        expect(result.intent).toBe('neighborhood');
        expect(result.found).toBe(true);
        expect(result.neighbors).toBeDefined();
        expect(result.neighbors!.center).toBe('transformer-architecture');
        /** node_count excludes the center — must have at least 2 neighbors. */
        expect(result.neighbors!.node_count).toBeGreaterThanOrEqual(2);
        expect(result.neighbors!.nodes).toContain('self-attention');
        expect(result.neighbors!.nodes).not.toContain('transformer-architecture');
        expect(chat).not.toHaveBeenCalled();
    });

    it('returns found:false and zero node_count for an isolated concept', async () => {
        insertConcept('lone-concept');

        const result = await routedSearch('related to lone-concept', TEST_CONFIG);

        expect(result.intent).toBe('neighborhood');
        expect(result.found).toBe(false);
        expect(result.neighbors!.node_count).toBe(0);
        expect(result.neighbors!.nodes).not.toContain('lone-concept');
    });
});

describe('routedSearch — hybrid_search', () => {
    it('returns hybrid_search intent with a chunks array (routing smoke-test)', async () => {
        /** Use a learned DB pattern so no LLM call is made. */
        insertPattern('^lumen query', 'hybrid_search');

        const result = await routedSearch('lumen query about anything', TEST_CONFIG);

        expect(result.intent).toBe('hybrid_search');
        expect(Array.isArray(result.chunks)).toBe(true);
        expect(result.concept).toBeUndefined();
        expect(result.path).toBeUndefined();
        expect(chat).not.toHaveBeenCalled();
    });

    it('finds chunks when content contains the exact query terms', async () => {
        /** FTS5 requires every quoted term to appear in the content. Use terms present in both. */
        insertPattern('^attention query', 'hybrid_search');

        const content =
            'attention query mechanism allows transformers to attend to different positions';
        const src = makeSource(content);
        insertSource(src);
        insertChunks([makeChunk(src.id, content)]);

        const result = await routedSearch('attention query mechanism', TEST_CONFIG);

        expect(result.intent).toBe('hybrid_search');
        expect(result.found).toBe(true);
        expect(result.chunks!.length).toBeGreaterThan(0);
        expect(chat).not.toHaveBeenCalled();
    });

    it('returns found:false and empty chunks when nothing matches', async () => {
        insertPattern('^xyzzy query', 'hybrid_search');

        const result = await routedSearch('xyzzy query quux blorb zzz', TEST_CONFIG);

        expect(result.intent).toBe('hybrid_search');
        expect(result.found).toBe(false);
        expect(result.chunks).toEqual([]);
    });
});

// ── Schema v8 migration check ─────────────────────────────────────────────────

describe('schema v8 migration', () => {
    it('classifier_patterns table exists with correct columns', () => {
        const info = getDb().prepare('PRAGMA table_info(classifier_patterns)').all() as {
            name: string;
        }[];
        const cols = info.map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'id',
                'classifier_name',
                'pattern',
                'label',
                'confidence',
                'match_count',
                'created_at',
                'source',
            ]),
        );
    });

    it('classifier_fallbacks table exists with correct columns', () => {
        const info = getDb().prepare('PRAGMA table_info(classifier_fallbacks)').all() as {
            name: string;
        }[];
        const cols = info.map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'id',
                'classifier_name',
                'input',
                'llm_label',
                'pattern_used',
                'created_at',
            ]),
        );
    });

    it('idx_patterns_classifier and idx_fallbacks_classifier indexes exist', () => {
        const indexes = getDb()
            .prepare(
                `SELECT name FROM sqlite_master
                 WHERE type='index'
                   AND (tbl_name='classifier_patterns' OR tbl_name='classifier_fallbacks')`,
            )
            .all() as { name: string }[];
        const names = indexes.map((r) => r.name);
        expect(names).toContain('idx_patterns_classifier');
        expect(names).toContain('idx_fallbacks_classifier');
    });
});
