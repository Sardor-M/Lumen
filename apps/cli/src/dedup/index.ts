/**
 * Public dedup API.
 *
 * Pure-arithmetic similarity primitives + a scope-aware merge policy.
 * No DB dependency - the store layer (`apps/cli/src/store/concepts.ts`) calls
 * these from inside `upsertConcept` to decide whether to insert a new concept
 * or fold the incoming data into an existing near-duplicate.
 */

export { tokenize, jaccardSimilarity, slugEditDistance, slugSimilarity } from './similarity.js';

export {
    findMergeCandidate,
    SLUG_SIM_THRESHOLD,
    CONTENT_SIM_THRESHOLD,
    MIN_CONTENT_TOKENS,
} from './policy.js';

export type {
    MergeCandidate,
    IncomingConcept,
    MergeDecision,
    MergePolicyOptions,
} from './policy.js';
