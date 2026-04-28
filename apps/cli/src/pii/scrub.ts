/**
 * PII scrubber.
 *
 * Walks the curated `PII_PATTERNS` list and produces a scrubbed copy plus a
 * count of redactions per pattern. In strict mode any redaction blocks the
 * write (returns `{ ok: false, reason }`); otherwise it returns `{ ok: true,
 * content, redactions }` where `content` is the scrubbed string and
 * `redactions` reports per-pattern counts.
 *
 * Idempotent: scrubbing already-scrubbed content is a no-op (the replacement
 * tokens don't match any pattern).
 *
 * See `docs/docs-temp/AGENT-LEARNING-SUBSTRATE.md` §6.4 for upstream context.
 */

import { PII_PATTERNS } from './patterns.js';
import type { PiiPattern, PiiPatternName } from './patterns.js';

export type ScrubOptions = {
    /** When true, any redaction returns `{ ok: false }` instead of scrubbing. */
    strict?: boolean;
    /** Pattern names to skip (use sparingly - opt-out is dangerous). */
    allow?: readonly PiiPatternName[];
};

export type ScrubSuccess = {
    ok: true;
    /** Scrubbed content. Identical to input when no patterns matched. */
    content: string;
    /** Total number of substring replacements across all patterns. */
    redactions: number;
    /** Per-pattern counts. Patterns that matched zero times are omitted. */
    by_pattern: Partial<Record<PiiPatternName, number>>;
};

export type ScrubFailure = {
    ok: false;
    /** Human-readable explanation. */
    reason: string;
    /** Per-pattern counts that triggered the rejection. */
    by_pattern: Partial<Record<PiiPatternName, number>>;
};

export type ScrubResult = ScrubSuccess | ScrubFailure;

/**
 * Scrub a single string. Returns success with the cleaned content + per-pattern
 * counts, or (in strict mode) failure when any pattern matched.
 *
 * Empty / whitespace-only input passes through unchanged with redactions=0.
 */
export function scrubPii(content: string, options: ScrubOptions = {}): ScrubResult {
    const allow = new Set<PiiPatternName>(options.allow ?? []);
    const strict = options.strict === true;

    if (!content) {
        return { ok: true, content, redactions: 0, by_pattern: {} };
    }

    const byPattern: Partial<Record<PiiPatternName, number>> = {};
    let working = content;

    for (const p of PII_PATTERNS) {
        if (allow.has(p.name)) continue;
        const { count, replaced } = applyPattern(working, p);
        if (count > 0) {
            byPattern[p.name] = count;
            working = replaced;
        }
    }

    const total = Object.values(byPattern).reduce<number>((sum, n) => sum + (n ?? 0), 0);

    if (strict && total > 0) {
        const detected = Object.keys(byPattern).join(', ');
        return {
            ok: false,
            reason: `strict mode rejected input - PII patterns detected: ${detected}`,
            by_pattern: byPattern,
        };
    }

    return { ok: true, content: working, redactions: total, by_pattern: byPattern };
}

/**
 * Apply one pattern to a string. Honors the optional `validate` predicate -
 * matches that fail validation are kept verbatim (no replacement, no count).
 */
function applyPattern(input: string, pattern: PiiPattern): { count: number; replaced: string } {
    let count = 0;

    /** Reset stateful flag so multiple .test() calls work correctly across inputs. */
    pattern.pattern.lastIndex = 0;

    const replaced = input.replace(pattern.pattern, (match) => {
        if (pattern.validate && !pattern.validate(match)) return match;
        count++;
        return pattern.replacement;
    });

    return { count, replaced };
}
