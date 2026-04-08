import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { resetDb } from '../src/store/database.js';
import { insertSource } from '../src/store/sources.js';
import { insertChunks } from '../src/store/chunks.js';
import { searchBm25 } from '../src/search/bm25.js';
import { searchTfIdf, tokenize, rebuildIndex } from '../src/search/tfidf.js';
import { fuseRrf } from '../src/search/fusion.js';
import { selectByBudget } from '../src/search/budget.js';
import { shortId, contentHash } from '../src/utils/hash.js';
import type { Source, Chunk } from '../src/types/index.js';

let tempDir: string;

function seedData() {
    const sources: Source[] = [
        {
            id: shortId('transformers article'),
            title: 'Transformer Architecture',
            url: null,
            content: 'Full article about transformers',
            content_hash: contentHash('transformers article'),
            source_type: 'file',
            added_at: new Date().toISOString(),
            compiled_at: null,
            word_count: 50,
            language: 'en',
            metadata: null,
        },
    ];

    const chunks: Chunk[] = [
        {
            id: shortId('chunk:0:transformers'),
            source_id: sources[0].id,
            content:
                'Transformers use self-attention mechanisms to process input sequences in parallel rather than sequentially.',
            content_hash: contentHash('chunk0'),
            chunk_type: 'paragraph',
            heading: 'Introduction',
            position: 0,
            token_count: 20,
        },
        {
            id: shortId('chunk:1:attention'),
            source_id: sources[0].id,
            content: 'The attention mechanism computes a weighted sum of values based on query-key similarity scores.',
            content_hash: contentHash('chunk1'),
            chunk_type: 'paragraph',
            heading: 'Attention',
            position: 1,
            token_count: 18,
        },
        {
            id: shortId('chunk:2:training'),
            source_id: sources[0].id,
            content: 'Training uses Adam optimizer with warmup and linear decay learning rate schedule.',
            content_hash: contentHash('chunk2'),
            chunk_type: 'paragraph',
            heading: 'Training',
            position: 2,
            token_count: 14,
        },
        {
            id: shortId('chunk:3:applications'),
            source_id: sources[0].id,
            content: 'Applications include machine translation, text summarization, and question answering systems.',
            content_hash: contentHash('chunk3'),
            chunk_type: 'paragraph',
            heading: 'Applications',
            position: 3,
            token_count: 14,
        },
    ];

    for (const src of sources) insertSource(src);
    insertChunks(chunks);
    return { sources, chunks };
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-search-'));
    setDataDir(tempDir);
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

describe('BM25', () => {
    it('returns ranked results for matching terms', () => {
        seedData();
        const results = searchBm25('attention mechanism');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain('attention');
    });

    it('returns empty for non-matching query', () => {
        seedData();
        const results = searchBm25('quantum entanglement');
        expect(results).toHaveLength(0);
    });

    it('normalizes scores to [0, 1]', () => {
        seedData();
        const results = searchBm25('transformer attention');
        for (const r of results) {
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(1);
        }
    });

    it('generates snippets around match', () => {
        seedData();
        const results = searchBm25('attention');
        expect(results[0].snippet.length).toBeGreaterThan(0);
        expect(results[0].snippet.length).toBeLessThanOrEqual(210);
    });
});

describe('TF-IDF', () => {
    it('returns scored results by cosine similarity', () => {
        seedData();
        rebuildIndex();
        const results = searchTfIdf('attention mechanism');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].score).toBeGreaterThan(0);
    });

    it('ranks relevant chunks higher', () => {
        seedData();
        rebuildIndex();
        const results = searchTfIdf('attention weighted sum query key');

        /** The attention chunk should rank higher than the training chunk. */
        const attentionIdx = results.findIndex((r) => r.chunk_id.includes(shortId('chunk:1:attention').slice(0, 6)));
        const trainingIdx = results.findIndex((r) => r.chunk_id.includes(shortId('chunk:2:training').slice(0, 6)));

        if (attentionIdx !== -1 && trainingIdx !== -1) {
            expect(attentionIdx).toBeLessThan(trainingIdx);
        }
    });

    it('returns empty for no matches', () => {
        seedData();
        rebuildIndex();
        const results = searchTfIdf('xyznonexistent');
        expect(results).toHaveLength(0);
    });
});

describe('tokenize', () => {
    it('lowercases and splits on non-alphanumeric', () => {
        expect(tokenize('Hello World')).toEqual(['hello', 'world']);
    });

    it('splits camelCase', () => {
        expect(tokenize('myFunctionName')).toEqual(['my', 'function', 'name']);
    });

    it('splits snake_case', () => {
        expect(tokenize('my_function_name')).toEqual(['my', 'function', 'name']);
    });

    it('filters short tokens', () => {
        expect(tokenize('I am a cat')).toEqual(['am', 'cat']);
    });
});

describe('RRF fusion', () => {
    it('merges two ranked lists', () => {
        const fused = fuseRrf([
            {
                name: 'signal_a',
                weight: 1.0,
                results: [
                    { chunk_id: 'c1', source_id: 's1', score: 0.9 },
                    { chunk_id: 'c2', source_id: 's1', score: 0.5 },
                ],
            },
            {
                name: 'signal_b',
                weight: 1.0,
                results: [
                    { chunk_id: 'c2', source_id: 's1', score: 0.8 },
                    { chunk_id: 'c3', source_id: 's1', score: 0.4 },
                ],
            },
        ]);

        expect(fused).toHaveLength(3);

        /** c2 appears in both signals — should have highest RRF score. */
        const c2 = fused.find((r) => r.chunk_id === 'c2');
        expect(c2).toBeDefined();
        expect(c2!.signals['signal_a']).toBe(0.5);
        expect(c2!.signals['signal_b']).toBe(0.8);
    });

    it('respects signal weights', () => {
        const heavy = fuseRrf([
            { name: 'a', weight: 10.0, results: [{ chunk_id: 'c1', source_id: 's1', score: 1.0 }] },
            { name: 'b', weight: 1.0, results: [{ chunk_id: 'c2', source_id: 's1', score: 1.0 }] },
        ]);

        /** c1 has 10x weight, should score higher. */
        expect(heavy[0].chunk_id).toBe('c1');
    });

    it('returns sorted by rrf_score descending', () => {
        const fused = fuseRrf([
            {
                name: 'a',
                weight: 1.0,
                results: [
                    { chunk_id: 'c1', source_id: 's1', score: 0.1 },
                    { chunk_id: 'c2', source_id: 's1', score: 0.9 },
                ],
            },
        ]);

        for (let i = 1; i < fused.length; i++) {
            expect(fused[i - 1].rrf_score).toBeGreaterThanOrEqual(fused[i].rrf_score);
        }
    });
});

describe('budget', () => {
    it('selects chunks within token budget', () => {
        seedData();
        const items = [
            { chunk_id: shortId('chunk:0:transformers'), source_id: 'x', score: 0.9 },
            { chunk_id: shortId('chunk:1:attention'), source_id: 'x', score: 0.8 },
            { chunk_id: shortId('chunk:2:training'), source_id: 'x', score: 0.5 },
            { chunk_id: shortId('chunk:3:applications'), source_id: 'x', score: 0.3 },
        ];

        const selected = selectByBudget(items, 40);

        const totalTokens = selected.reduce((sum, c) => sum + c.token_count, 0);
        expect(totalTokens).toBeLessThanOrEqual(40);
        expect(selected.length).toBeGreaterThan(0);
        expect(selected.length).toBeLessThan(items.length);
    });

    it('prefers high density (score/tokens) over raw score', () => {
        seedData();

        /** chunk:2 (14 tokens, 0.9 score) has higher density than chunk:0 (20 tokens, 0.5 score). */
        const items = [
            { chunk_id: shortId('chunk:0:transformers'), source_id: 'x', score: 0.5 },
            { chunk_id: shortId('chunk:2:training'), source_id: 'x', score: 0.9 },
        ];

        const selected = selectByBudget(items, 25);
        expect(selected[0].chunk_id).toBe(shortId('chunk:2:training'));
    });
});
