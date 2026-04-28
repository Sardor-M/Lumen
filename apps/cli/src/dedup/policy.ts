/**
 * Merge-on-write policy.
 *
 * Given an incoming concept and the set of existing concepts in its scope,
 * decide whether to merge it into one of them and which existing one wins as
 * canonical. Pure function - no DB dependency.
 *
 * Decision rule (both signals required):
 *   - slug similarity >= SLUG_SIM_THRESHOLD (Levenshtein-based)
 *   - content Jaccard  >= CONTENT_SIM_THRESHOLD
 * Retired candidates are skipped - we never merge into a retired concept;
 * the new one stays as a fresh active concept instead.
 *
 * Tie-breaking: when multiple candidates clear both thresholds, the one with
 * the highest combined `(score, mention_count)` wins. Ties beyond that fall
 * through to the lexicographically earliest slug for determinism.
 */

import { jaccardSimilarity, slugSimilarity, tokenize } from './similarity.js';

/** Minimum slug similarity (Levenshtein-normalized) for two concepts to even be considered. */
export const SLUG_SIM_THRESHOLD = 0.7;
/** Minimum content Jaccard for the merge to fire once slugs are similar enough. */
export const CONTENT_SIM_THRESHOLD = 0.6;
/**
 * Minimum distinct token count required on BOTH sides before a content
 * comparison is trusted. Below this threshold we treat the content as too
 * thin to confidently say two concepts mean the same thing - even if their
 * jaccard scores high by coincidence (e.g. two stub concepts whose only
 * shared token is "concept"). Real compiled_truth bodies blow past this
 * easily; test fixtures with empty content do not.
 */
export const MIN_CONTENT_TOKENS = 4;

export type MergeCandidate = {
    slug: string;
    /** compiled_truth, summary, or any text representation used for content comparison. */
    content: string;
    /** Cumulative skill score; tie-break key. */
    score: number;
    /** Mention count; secondary tie-break key. */
    mention_count: number;
    /** Retired concepts are excluded from merging. */
    retired_at: string | null;
};

export type IncomingConcept = {
    slug: string;
    content: string;
};

export type MergeDecision =
    | {
          merge: true;
          /** The existing concept that wins as canonical. */
          canonical: MergeCandidate;
          /** Similarity scores that triggered the merge - useful for the alias reason. */
          slug_sim: number;
          content_sim: number;
      }
    | { merge: false; reason: 'no_candidates' | 'below_threshold' | 'thin_content' };

export type MergePolicyOptions = {
    slug_threshold?: number;
    content_threshold?: number;
    min_tokens?: number;
};

/**
 * Decide whether `incoming` should merge into one of `candidates`.
 * Caller is responsible for scope-filtering candidates first - this function
 * trusts that every candidate is in the same scope as the incoming concept.
 */
export function findMergeCandidate(
    incoming: IncomingConcept,
    candidates: readonly MergeCandidate[],
    options: MergePolicyOptions = {},
): MergeDecision {
    const slugThreshold = options.slug_threshold ?? SLUG_SIM_THRESHOLD;
    const contentThreshold = options.content_threshold ?? CONTENT_SIM_THRESHOLD;
    const minTokens = options.min_tokens ?? MIN_CONTENT_TOKENS;

    /** Empty-candidates check first - no candidates is no work, regardless of content. */
    const active = candidates.filter((c) => c.retired_at === null && c.slug !== incoming.slug);
    if (active.length === 0) {
        return { merge: false, reason: 'no_candidates' };
    }

    /** Thin-content guard - both sides need enough signal to compare. */
    const incomingTokens = new Set(tokenize(incoming.content)).size;
    if (incomingTokens < minTokens) {
        return { merge: false, reason: 'thin_content' };
    }

    type Scored = MergeCandidate & { slug_sim: number; content_sim: number };

    const matches: Scored[] = [];
    for (const candidate of active) {
        const candidateTokens = new Set(tokenize(candidate.content)).size;
        if (candidateTokens < minTokens) continue;
        const slugSim = slugSimilarity(incoming.slug, candidate.slug);
        if (slugSim < slugThreshold) continue;
        const contentSim = jaccardSimilarity(incoming.content, candidate.content);
        if (contentSim < contentThreshold) continue;
        matches.push({ ...candidate, slug_sim: slugSim, content_sim: contentSim });
    }

    if (matches.length === 0) {
        return { merge: false, reason: 'below_threshold' };
    }

    matches.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.mention_count !== a.mention_count) return b.mention_count - a.mention_count;
        return a.slug.localeCompare(b.slug);
    });

    const winner = matches[0];
    return {
        merge: true,
        canonical: {
            slug: winner.slug,
            content: winner.content,
            score: winner.score,
            mention_count: winner.mention_count,
            retired_at: winner.retired_at,
        },
        slug_sim: winner.slug_sim,
        content_sim: winner.content_sim,
    };
}
