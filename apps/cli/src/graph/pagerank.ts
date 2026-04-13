import { listConcepts } from '../store/concepts.js';
import { getNeighbors } from '../store/edges.js';

type PageRankResult = {
    slug: string;
    name: string;
    score: number;
};

/**
 * PageRank scoring for concept importance.
 * Iterative power method on the concept adjacency matrix.
 *
 * Reference: Page, Brin, Motwani & Winograd,
 * "The PageRank Citation Ranking", 1998.
 */
export function pagerank(opts?: {
    damping?: number;
    iterations?: number;
    tolerance?: number;
}): PageRankResult[] {
    const damping = opts?.damping ?? 0.85;
    const maxIter = opts?.iterations ?? 100;
    const tolerance = opts?.tolerance ?? 1e-6;

    const concepts = listConcepts();
    if (concepts.length === 0) return [];

    const n = concepts.length;
    const slugs = concepts.map((c) => c.slug);
    const slugIndex = new Map(slugs.map((s, i) => [s, i]));

    /** Build adjacency: outgoing neighbors for each node. */
    const outLinks: number[][] = new Array(n);
    const inLinks: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
        outLinks[i] = [];
        inLinks[i] = [];
    }

    for (let i = 0; i < n; i++) {
        const neighbors = getNeighbors(slugs[i]);
        for (const neighbor of neighbors) {
            const j = slugIndex.get(neighbor);
            if (j !== undefined) {
                outLinks[i].push(j);
                inLinks[j].push(i);
            }
        }
    }

    /** Initialize scores uniformly. */
    let scores = new Float64Array(n).fill(1 / n);
    const base = (1 - damping) / n;

    /** Power iteration. */
    for (let iter = 0; iter < maxIter; iter++) {
        const next = new Float64Array(n).fill(base);

        /** Accumulate contributions from dangling nodes (no outlinks). */
        let danglingSum = 0;
        for (let i = 0; i < n; i++) {
            if (outLinks[i].length === 0) danglingSum += scores[i];
        }
        const danglingContrib = (damping * danglingSum) / n;

        for (let i = 0; i < n; i++) {
            next[i] += danglingContrib;
        }

        /** Accumulate contributions from inbound links. */
        for (let j = 0; j < n; j++) {
            for (const i of inLinks[j]) {
                next[j] += (damping * scores[i]) / outLinks[i].length;
            }
        }

        /** Check convergence. */
        let diff = 0;
        for (let i = 0; i < n; i++) diff += Math.abs(next[i] - scores[i]);
        scores = next;

        if (diff < tolerance) break;
    }

    /** Build results sorted by score descending. */
    const results: PageRankResult[] = [];
    for (let i = 0; i < n; i++) {
        results.push({ slug: slugs[i], name: concepts[i].name, score: scores[i] });
    }

    return results.sort((a, b) => b.score - a.score);
}
