import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertSource } from '../src/store/sources.js';
import { upsertConcept, linkSourceConcept } from '../src/store/concepts.js';
import { upsertEdge } from '../src/store/edges.js';
import { logQuery } from '../src/store/query-log.js';
import { buildProfile } from '../src/profile/builder.js';
import { getProfile, invalidateProfileCache, saveProfileCache } from '../src/profile/cache.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-profile-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

/** Seed a realistic corpus: S sources, C concepts, E edges, Q query log entries. */
function seedCorpus(opts: { sources: number; concepts: number; edges: number; queries: number }) {
    const now = new Date().toISOString();

    for (let i = 0; i < opts.sources; i++) {
        insertSource({
            id: `src-${i}`,
            title: `Source ${i}`,
            url: `https://example.com/${i}`,
            content: `Content for source ${i}`,
            content_hash: `hash-${i}`,
            source_type: 'url',
            added_at: now,
            compiled_at: i % 3 === 0 ? null : now,
            word_count: 100,
            language: 'en',
            metadata: null,
        });
    }

    for (let i = 0; i < opts.concepts; i++) {
        upsertConcept({
            slug: `concept-${i}`,
            name: `Concept ${i}`,
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
        linkSourceConcept({
            source_id: `src-${i % opts.sources}`,
            concept_slug: `concept-${i}`,
            relevance: 0.5,
        });
    }

    /** Build a mix of edges: sequential (chain), hub (concept-0 fans out), and random cross-links. */
    let edgesAdded = 0;
    for (let i = 0; i < opts.concepts - 1 && edgesAdded < opts.edges; i++) {
        upsertEdge({
            from_slug: `concept-${i}`,
            to_slug: `concept-${i + 1}`,
            relation: 'related',
            weight: 1,
            source_id: null,
        });
        edgesAdded++;
    }
    for (let i = 1; i < opts.concepts && edgesAdded < opts.edges; i++) {
        upsertEdge({
            from_slug: 'concept-0',
            to_slug: `concept-${i}`,
            relation: 'supports',
            weight: 1,
            source_id: null,
        });
        edgesAdded++;
    }

    for (let i = 0; i < opts.queries; i++) {
        logQuery({
            tool_name: i % 2 === 0 ? 'search' : 'query',
            query_text: `query topic ${i % 7}`,
            result_count: 5,
            latency_ms: null,
            session_id: null,
        });
    }
}

describe('profile', () => {
    it('builds a profile over a small corpus without errors', () => {
        seedCorpus({ sources: 5, concepts: 10, edges: 15, queries: 3 });
        const profile = buildProfile();

        expect(profile.static.total_sources).toBe(5);
        expect(profile.static.total_concepts).toBe(10);
        expect(profile.static.total_edges).toBeGreaterThan(0);
        expect(profile.static.god_nodes.length).toBeGreaterThan(0);
        expect(profile.learned.frequent_topics.length).toBeGreaterThan(0);
        expect(profile.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('cached read is dramatically faster than a cold build', () => {
        seedCorpus({ sources: 50, concepts: 100, edges: 200, queries: 20 });

        /** Prime the cache. */
        saveProfileCache(buildProfile());

        /** Cold build — force rebuild, measure. */
        const coldStart = performance.now();
        getProfile(true);
        const coldMs = performance.now() - coldStart;

        /** Warm read from cache. */
        const warmStart = performance.now();
        const warm = getProfile(false);
        const warmMs = performance.now() - warmStart;

        expect(warm.static.total_concepts).toBe(100);
        /** Cache read should be at least 5× faster than rebuild. */
        expect(warmMs).toBeLessThan(coldMs / 5);
    });

    it('cached profile read meets the <50ms roadmap target', () => {
        seedCorpus({ sources: 50, concepts: 100, edges: 200, queries: 20 });
        saveProfileCache(buildProfile());

        /** Discard the first read (JIT warmup), average the next 5. */
        getProfile(false);

        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
            const start = performance.now();
            getProfile(false);
            samples.push(performance.now() - start);
        }
        const median = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];

        expect(median).toBeLessThan(50);
    });

    it('invalidate forces a rebuild on the next read', () => {
        seedCorpus({ sources: 3, concepts: 5, edges: 5, queries: 1 });
        const first = getProfile(false);

        invalidateProfileCache();

        /** Add another source; next read should observe it after the rebuild. */
        insertSource({
            id: 'src-new',
            title: 'Newly added',
            url: null,
            content: 'new',
            content_hash: 'hash-new',
            source_type: 'file',
            added_at: new Date().toISOString(),
            compiled_at: null,
            word_count: 10,
            language: null,
            metadata: null,
        });

        const second = getProfile(false);
        expect(second.static.total_sources).toBe(first.static.total_sources + 1);
    });
});
