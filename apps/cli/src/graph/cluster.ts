import { listConcepts } from '../store/concepts.js';
import { getNeighbors } from '../store/edges.js';

type Community = {
    id: number;
    members: string[];
    size: number;
};

/**
 * Label Propagation community detection.
 * Each node starts with its own label, then iteratively adopts
 * the most common label among its neighbors.
 *
 * Reference: Raghavan, Albert & Kumara,
 * "Near linear time algorithm to detect community structures
 * in large-scale networks", 2007.
 */
export function detectCommunities(maxIterations = 50): Community[] {
    const concepts = listConcepts();
    if (concepts.length === 0) return [];

    const slugs = concepts.map((c) => c.slug);

    /** Initialize: each node is its own community. */
    const labels = new Map<string, number>();
    slugs.forEach((s, i) => labels.set(s, i));

    /** Iterate until stable or max iterations. */
    for (let iter = 0; iter < maxIterations; iter++) {
        let changed = false;

        /** Shuffle order each iteration for convergence stability. */
        const shuffled = [...slugs];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        for (const slug of shuffled) {
            const neighbors = getNeighbors(slug);
            if (neighbors.length === 0) continue;

            /** Count label frequencies among neighbors. */
            const freq = new Map<number, number>();
            for (const neighbor of neighbors) {
                const label = labels.get(neighbor);
                if (label !== undefined) {
                    freq.set(label, (freq.get(label) ?? 0) + 1);
                }
            }

            /** Adopt the most frequent label. */
            let maxCount = 0;
            let bestLabel = labels.get(slug)!;
            for (const [label, count] of freq) {
                if (count > maxCount) {
                    maxCount = count;
                    bestLabel = label;
                }
            }

            if (bestLabel !== labels.get(slug)) {
                labels.set(slug, bestLabel);
                changed = true;
            }
        }

        if (!changed) break;
    }

    /** Group slugs by label. */
    const groups = new Map<number, string[]>();
    for (const [slug, label] of labels) {
        let group = groups.get(label);
        if (!group) {
            group = [];
            groups.set(label, group);
        }
        group.push(slug);
    }

    /** Sort communities by size descending, assign sequential IDs. */
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length);

    return sorted.map((members, i) => ({
        id: i,
        members,
        size: members.length,
    }));
}
