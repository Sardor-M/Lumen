import type { EnrichmentTier } from '../types/index.js';

/**
 * Tier thresholds for auto-escalation.
 * Distinct source count matters more than raw mention count —
 * a concept seen 10x in one paper is less important than one seen 3x across 3 papers.
 */
export const TIER_THRESHOLDS = {
    tier1: { mentions: 6, distinct_sources: 3 },
    tier2: { mentions: 3, distinct_sources: 2 },
    tier3: { mentions: 1, distinct_sources: 1 },
} as const;

/** Compute the enrichment tier given evidence density. Lower = richer. */
export function computeTier(mentionCount: number, distinctSources: number): EnrichmentTier {
    if (
        mentionCount >= TIER_THRESHOLDS.tier1.mentions &&
        distinctSources >= TIER_THRESHOLDS.tier1.distinct_sources
    )
        return 1;
    if (
        mentionCount >= TIER_THRESHOLDS.tier2.mentions &&
        distinctSources >= TIER_THRESHOLDS.tier2.distinct_sources
    )
        return 2;
    return 3;
}
