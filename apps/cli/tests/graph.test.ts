import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { upsertConcept } from '../src/store/concepts.js';
import { upsertEdge } from '../src/store/edges.js';
import { shortestPath, neighborhood, connectedComponents, godNodes } from '../src/graph/engine.js';
import { pagerank } from '../src/graph/pagerank.js';
import { detectCommunities } from '../src/graph/cluster.js';

let tempDir: string;

/** Seed a small graph for testing:
 *  A --supports--> B --extends--> C
 *  A --related---> D
 *  E (isolated)
 */
function seedGraph(): void {
    const now = new Date().toISOString();
    const concepts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const slug of concepts) {
        upsertConcept({
            slug,
            name: slug.charAt(0).toUpperCase() + slug.slice(1),
            summary: `Concept ${slug}`,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });
    }
    upsertEdge({
        from_slug: 'alpha',
        to_slug: 'beta',
        relation: 'supports',
        weight: 0.8,
        source_id: 's1',
    });
    upsertEdge({
        from_slug: 'beta',
        to_slug: 'gamma',
        relation: 'extends',
        weight: 0.7,
        source_id: 's1',
    });
    upsertEdge({
        from_slug: 'alpha',
        to_slug: 'delta',
        relation: 'related',
        weight: 0.5,
        source_id: 's1',
    });
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-graph-'));
    setDataDir(tempDir);
    getDb();
    seedGraph();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

describe('shortestPath', () => {
    it('finds direct path between connected concepts', () => {
        const result = shortestPath('alpha', 'beta');
        expect(result).not.toBeNull();
        expect(result!.path).toEqual(['alpha', 'beta']);
        expect(result!.hops).toBe(1);
    });

    it('finds multi-hop path', () => {
        const result = shortestPath('alpha', 'gamma');
        expect(result).not.toBeNull();
        expect(result!.path).toEqual(['alpha', 'beta', 'gamma']);
        expect(result!.hops).toBe(2);
    });

    it('returns null for disconnected concepts', () => {
        const result = shortestPath('alpha', 'epsilon');
        expect(result).toBeNull();
    });

    it('returns self-path with 0 hops', () => {
        const result = shortestPath('alpha', 'alpha');
        expect(result).not.toBeNull();
        expect(result!.path).toEqual(['alpha']);
        expect(result!.hops).toBe(0);
    });
});

describe('neighborhood', () => {
    it('returns direct neighbors at depth 1', () => {
        const result = neighborhood('alpha', 1);
        expect(result.center).toBe('alpha');
        expect(result.nodes.has('alpha')).toBe(true);
        expect(result.nodes.has('beta')).toBe(true);
        expect(result.nodes.has('delta')).toBe(true);
        expect(result.nodes.has('gamma')).toBe(false);
    });

    it('expands to 2 hops', () => {
        const result = neighborhood('alpha', 2);
        expect(result.nodes.has('gamma')).toBe(true);
        expect(result.depth).toBe(2);
    });

    it('does not include isolated nodes', () => {
        const result = neighborhood('alpha', 3);
        expect(result.nodes.has('epsilon')).toBe(false);
    });

    it('returns only self for isolated node', () => {
        const result = neighborhood('epsilon', 2);
        expect(result.nodes.size).toBe(1);
        expect(result.nodes.has('epsilon')).toBe(true);
    });
});

describe('connectedComponents', () => {
    it('identifies separate components', () => {
        const components = connectedComponents();
        expect(components.length).toBe(2);
        /** Largest component first. */
        expect(components[0].length).toBe(4);
        expect(components[1].length).toBe(1);
        expect(components[1]).toContain('epsilon');
    });
});

describe('godNodes', () => {
    it('ranks nodes by edge count descending', () => {
        const gods = godNodes(3);
        expect(gods.length).toBe(3);
        /** Alpha has 2 edges: supports beta, related delta. */
        expect(gods[0].slug).toBe('alpha');
        expect(gods[0].edgeCount).toBeGreaterThanOrEqual(2);
    });

    it('respects limit', () => {
        const gods = godNodes(1);
        expect(gods.length).toBe(1);
    });
});

describe('pagerank', () => {
    it('returns scores that sum to approximately 1', () => {
        const results = pagerank();
        const sum = results.reduce((s, r) => s + r.score, 0);
        expect(sum).toBeCloseTo(1, 2);
    });

    it('ranks connected nodes higher than isolated ones', () => {
        const results = pagerank();
        const alphaScore = results.find((r) => r.slug === 'alpha')!.score;
        const epsilonScore = results.find((r) => r.slug === 'epsilon')!.score;
        expect(alphaScore).toBeGreaterThan(epsilonScore);
    });

    it('returns empty array for empty graph', () => {
        resetDb();
        resetDataDir();
        const emptyDir = mkdtempSync(join(tmpdir(), 'lumen-empty-'));
        setDataDir(emptyDir);
        getDb();
        const results = pagerank();
        expect(results).toEqual([]);
        resetDb();
        resetDataDir();
        rmSync(emptyDir, { recursive: true, force: true });
    });

    it('converges with custom parameters', () => {
        const results = pagerank({ damping: 0.5, iterations: 10 });
        expect(results.length).toBe(5);
        expect(results[0].score).toBeGreaterThan(0);
    });
});

describe('detectCommunities', () => {
    it('groups connected nodes into communities', () => {
        const communities = detectCommunities();
        expect(communities.length).toBeGreaterThanOrEqual(1);
        /** Largest community should contain alpha, beta, gamma, delta. */
        const largest = communities[0];
        expect(largest.size).toBeGreaterThanOrEqual(2);
    });

    it('isolates disconnected nodes', () => {
        const communities = detectCommunities();
        /** Epsilon should be in its own community. */
        const epsilonCommunity = communities.find((c) => c.members.includes('epsilon'));
        expect(epsilonCommunity).toBeDefined();
        expect(epsilonCommunity!.size).toBe(1);
    });

    it('assigns sequential IDs sorted by size', () => {
        const communities = detectCommunities();
        for (let i = 1; i < communities.length; i++) {
            expect(communities[i].id).toBe(i);
            expect(communities[i].size).toBeLessThanOrEqual(communities[i - 1].size);
        }
    });
});
