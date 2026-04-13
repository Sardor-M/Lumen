/**
 * Reciprocal Rank Fusion — merges ranked lists from multiple signals.
 *
 * Reference: Cormack, Clarke & Butt, "Reciprocal Rank Fusion outperforms
 * Condorcet and individual Rank Learning Methods", 2009.
 *
 * Formula: rrf_score(d) = Σ (weight_i / (k + rank_i(d)))
 */

type RankedItem = {
    chunk_id: string;
    source_id: string;
    score: number;
};

type FusedResult = {
    chunk_id: string;
    source_id: string;
    rrf_score: number;
    signals: Record<string, number>;
};

type SignalInput = {
    name: string;
    results: RankedItem[];
    weight: number;
};

/**
 * Fuse multiple ranked result lists using weighted RRF.
 * Each signal contributes: weight / (k + rank) where rank is 1-based.
 */
export function fuseRrf(signals: SignalInput[], k = 60): FusedResult[] {
    const fused = new Map<string, FusedResult>();

    for (const signal of signals) {
        for (let rank = 0; rank < signal.results.length; rank++) {
            const item = signal.results[rank];
            const rrfContribution = signal.weight / (k + rank + 1);

            let entry = fused.get(item.chunk_id);
            if (!entry) {
                entry = {
                    chunk_id: item.chunk_id,
                    source_id: item.source_id,
                    rrf_score: 0,
                    signals: {},
                };
                fused.set(item.chunk_id, entry);
            }

            entry.rrf_score += rrfContribution;
            entry.signals[signal.name] = item.score;
        }
    }

    const results = [...fused.values()];
    results.sort((a, b) => b.rrf_score - a.rrf_score);
    return results;
}
