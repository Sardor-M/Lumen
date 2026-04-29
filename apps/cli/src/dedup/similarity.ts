/**
 * Pure similarity primitives for near-duplicate concept detection.
 *
 * Self-contained - no DB dependency, no module-level state. The merge policy
 * (`policy.ts`) composes these into a decision; this file only provides the
 * arithmetic.
 *
 * Why two signals instead of one:
 *   - Slug similarity catches concepts that *named* the same thing slightly
 *     differently ("react-hooks" vs "react_hooks", "add-route" vs "add-routes").
 *   - Content Jaccard catches concepts whose names diverge but whose
 *     compiled_truth describes the same thing.
 *   - Requiring both keeps "react-router" and "react-hooks" apart even though
 *     their slugs are close, because their content tokens diverge.
 */

/**
 * Tokenize content into a lowercase a-z0-9 word set, dropping tokens shorter
 * than 3 chars.
 *
 * ASCII-only by design. Non-ASCII content (Cyrillic, CJK, Arabic, etc.)
 * tokenizes to an empty set, which trips the policy's thin-content guard
 * and skips the merge entirely. This is the safe default for an English-
 * first codebase: we'd rather skip merging non-English concepts than risk
 * false-positive folds on a tokenizer we haven't validated for that script.
 * If multilingual support becomes a real need, switch the split character
 * class to `/[^\p{L}\p{N}]+/u` and add coverage in similarity tests.
 */
export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3);
}

/**
 * Jaccard similarity between two token bags. Returns 0..1.
 * Empty inputs return 0 (not NaN, not 1) - empty strings shouldn't merge.
 */
export function jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Levenshtein edit distance between two slugs.
 * Used as a cheap pre-filter before computing the more expensive content
 * Jaccard - if the slugs are wildly different, skip the comparison.
 *
 * O(n*m) time, O(min(n,m)) space.
 */
export function slugEditDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    /** Make `a` the shorter string so the inner array stays small. */
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    const m = shorter.length;
    const n = longer.length;

    let prev = new Array<number>(m + 1);
    for (let i = 0; i <= m; i++) prev[i] = i;
    let curr = new Array<number>(m + 1).fill(0);

    for (let j = 1; j <= n; j++) {
        curr[0] = j;
        for (let i = 1; i <= m; i++) {
            const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
            /**
             * Three classic edit operations:
             *   curr[i-1] + 1  : insertion
             *   prev[i] + 1    : deletion
             *   prev[i-1] + c  : substitution (cost 0 when chars match)
             */
            curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[m];
}

/**
 * Normalized slug similarity in [0, 1]. 1 = identical, 0 = totally different.
 * Useful as a single number against a threshold.
 */
export function slugSimilarity(a: string, b: string): number {
    const longest = Math.max(a.length, b.length);
    if (longest === 0) return 1;
    return 1 - slugEditDistance(a, b) / longest;
}
