import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    insertSource,
    getSource,
    getSourceByHash,
    listSources,
    markCompiled,
    deleteSource,
    countSources,
    countSourcesByType,
} from '../src/store/sources.js';
import {
    insertChunks,
    getChunksBySource,
    searchChunksFts,
    deleteChunksBySource,
    countChunks,
    totalTokens,
} from '../src/store/chunks.js';
import {
    upsertConcept,
    getConcept,
    listConcepts,
    countConcepts,
    linkSourceConcept,
    getConceptSources,
    getSourceConcepts,
} from '../src/store/concepts.js';
import {
    upsertEdge,
    getEdgesFrom,
    getEdgesTo,
    getNeighbors,
    countEdges,
} from '../src/store/edges.js';
import { sourceExists, chunkExists } from '../src/store/dedup.js';
import { contentHash, shortId } from '../src/utils/hash.js';
import type { Source, Chunk, Concept, Edge } from '../src/types/index.js';

let tempDir: string;

function makeSource(content: string, overrides?: Partial<Source>): Source {
    return {
        id: shortId(content),
        title: 'Test Source',
        url: null,
        content,
        content_hash: contentHash(content),
        source_type: 'file',
        added_at: new Date().toISOString(),
        compiled_at: null,
        word_count: content.split(/\s+/).length,
        language: null,
        metadata: null,
        ...overrides,
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

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-test-'));
    setDataDir(tempDir);
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

describe('sources', () => {
    it('inserts and retrieves a source', () => {
        const src = makeSource('Hello world');
        insertSource(src);
        const found = getSource(src.id);
        expect(found).not.toBeNull();
        expect(found!.title).toBe('Test Source');
        expect(found!.content).toBe('Hello world');
    });

    it('finds source by content hash', () => {
        const src = makeSource('unique content');
        insertSource(src);
        const found = getSourceByHash(src.content_hash);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(src.id);
    });

    it('lists sources with type filter', () => {
        insertSource(makeSource('article one', { source_type: 'url' }));
        insertSource(makeSource('paper two', { source_type: 'pdf' }));
        insertSource(makeSource('video three', { source_type: 'youtube' }));

        const urls = listSources({ type: 'url' });
        expect(urls).toHaveLength(1);
        expect(urls[0].source_type).toBe('url');

        const all = listSources();
        expect(all).toHaveLength(3);
    });

    it('lists sources with compiled filter', () => {
        const src = makeSource('compilable content');
        insertSource(src);

        expect(listSources({ compiled: false })).toHaveLength(1);
        expect(listSources({ compiled: true })).toHaveLength(0);

        markCompiled(src.id);

        expect(listSources({ compiled: false })).toHaveLength(0);
        expect(listSources({ compiled: true })).toHaveLength(1);
    });

    it('deletes a source', () => {
        const src = makeSource('to be deleted');
        insertSource(src);
        expect(countSources()).toBe(1);
        deleteSource(src.id);
        expect(countSources()).toBe(0);
    });

    it('counts sources by type', () => {
        insertSource(makeSource('a', { source_type: 'url' }));
        insertSource(makeSource('b', { source_type: 'url' }));
        insertSource(makeSource('c', { source_type: 'pdf' }));

        const byType = countSourcesByType();
        expect(byType['url']).toBe(2);
        expect(byType['pdf']).toBe(1);
    });
});

describe('chunks', () => {
    it('batch inserts and retrieves chunks', () => {
        const src = makeSource('parent source');
        insertSource(src);

        const chunks = [
            makeChunk(src.id, 'First paragraph about transformers', 0),
            makeChunk(src.id, 'Second paragraph about attention', 1),
            makeChunk(src.id, 'Third paragraph about embeddings', 2),
        ];
        insertChunks(chunks);

        const retrieved = getChunksBySource(src.id);
        expect(retrieved).toHaveLength(3);
        expect(retrieved[0].position).toBe(0);
        expect(retrieved[2].position).toBe(2);
    });

    it('searches via FTS5', () => {
        const src = makeSource('fts test source');
        insertSource(src);

        insertChunks([
            makeChunk(src.id, 'Transformers use self-attention mechanisms', 0),
            makeChunk(src.id, 'Convolutional networks use pooling layers', 1),
        ]);

        const results = searchChunksFts('attention');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].content).toContain('attention');
    });

    it('handles hyphenated FTS5 queries', () => {
        const src = makeSource('hyphen test');
        insertSource(src);

        insertChunks([makeChunk(src.id, 'Self-attention is a key mechanism in transformers', 0)]);

        /** This would fail without proper quoting — hyphens are FTS5 operators. */
        const results = searchChunksFts('self-attention');
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('counts chunks and tokens', () => {
        const src = makeSource('counter test');
        insertSource(src);

        insertChunks([
            { ...makeChunk(src.id, 'a', 0), token_count: 100 },
            { ...makeChunk(src.id, 'b', 1), token_count: 200 },
        ]);

        expect(countChunks()).toBe(2);
        expect(totalTokens()).toBe(300);
    });

    it('deletes chunks by source', () => {
        const src = makeSource('delete chunks test');
        insertSource(src);
        insertChunks([makeChunk(src.id, 'will be deleted', 0)]);

        expect(countChunks()).toBe(1);
        deleteChunksBySource(src.id);
        expect(countChunks()).toBe(0);
    });
});

describe('concepts', () => {
    it('upserts a concept and increments mention count', () => {
        const now = new Date().toISOString();
        const concept: Concept = {
            slug: 'transformer',
            name: 'Transformer',
            summary: 'A neural network architecture',
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        };

        upsertConcept(concept);
        expect(getConcept('transformer')!.mention_count).toBe(1);

        upsertConcept({ ...concept, updated_at: new Date().toISOString() });
        expect(getConcept('transformer')!.mention_count).toBe(2);
    });

    it('lists concepts ordered by mention count', () => {
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'a',
            name: 'A',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 5,
        });
        upsertConcept({
            slug: 'b',
            name: 'B',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 10,
        });

        const list = listConcepts();
        expect(list[0].slug).toBe('b');
        expect(list[1].slug).toBe('a');
    });

    it('links sources to concepts', () => {
        const src = makeSource('linked source');
        insertSource(src);

        const now = new Date().toISOString();
        upsertConcept({
            slug: 'test-concept',
            name: 'Test',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });

        linkSourceConcept({ source_id: src.id, concept_slug: 'test-concept', relevance: 0.9 });

        expect(getConceptSources('test-concept')).toContain(src.id);
        expect(getSourceConcepts(src.id)).toContain('test-concept');
    });
});

describe('edges', () => {
    it('upserts edges and finds neighbors', () => {
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'a',
            name: 'A',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
        upsertConcept({
            slug: 'b',
            name: 'B',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });

        const edge: Edge = {
            from_slug: 'a',
            to_slug: 'b',
            relation: 'related',
            weight: 0.8,
            source_id: null,
        };
        upsertEdge(edge);

        expect(countEdges()).toBe(1);
        expect(getEdgesFrom('a')).toHaveLength(1);
        expect(getEdgesTo('b')).toHaveLength(1);
        expect(getNeighbors('a')).toContain('b');
        expect(getNeighbors('b')).toContain('a');
    });

    it('upsert keeps max weight', () => {
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'x',
            name: 'X',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
        upsertConcept({
            slug: 'y',
            name: 'Y',
            summary: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });

        upsertEdge({
            from_slug: 'x',
            to_slug: 'y',
            relation: 'supports',
            weight: 0.5,
            source_id: null,
        });
        upsertEdge({
            from_slug: 'x',
            to_slug: 'y',
            relation: 'supports',
            weight: 0.9,
            source_id: null,
        });

        const edges = getEdgesFrom('x');
        expect(edges).toHaveLength(1);
        expect(edges[0].weight).toBe(0.9);
    });
});

describe('dedup', () => {
    it('detects duplicate sources by content hash', () => {
        const db = getDb();
        const src = makeSource('duplicate me');
        insertSource(src);

        expect(sourceExists(db, 'duplicate me')).toBe(src.id);
        expect(sourceExists(db, 'different content')).toBeNull();
    });
});
