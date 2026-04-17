import { getDb } from '../store/database.js';
import { chat } from '../llm/client.js';
import type { LumenConfig } from '../types/index.js';

type PatternRow = {
    pattern: string;
    label: string;
    confidence: number;
};

type FallbackGroup = {
    input: string;
    llm_label: string;
    cnt: number;
};

/**
 * Extract new deterministic patterns from recent LLM fallbacks.
 * Asks the LLM to produce regexes that generalise repeated decisions,
 * validates them, and stores the good ones so future calls skip the LLM.
 *
 * Returns the number of new patterns added.
 * Safe to call repeatedly — uses INSERT OR IGNORE so duplicates are skipped.
 */
export async function extractPatterns(
    config: LumenConfig,
    classifierName = 'intent',
): Promise<number> {
    const db = getDb();

    /** Gather fallbacks that have occurred at least twice and not yet been processed. */
    const fallbacks = db
        .prepare(
            `SELECT input, llm_label, COUNT(*) AS cnt
             FROM classifier_fallbacks
             WHERE classifier_name = ? AND pattern_used IS NULL
             GROUP BY llm_label, input
             HAVING cnt >= 2
             ORDER BY cnt DESC
             LIMIT 20`,
        )
        .all(classifierName) as FallbackGroup[];

    if (fallbacks.length === 0) return 0;

    const examples = fallbacks
        .map((f) => `input: "${f.input}" -> label: "${f.llm_label}" (seen ${f.cnt}x)`)
        .join('\n');

    const prompt = `These are classification decisions made by an LLM for the "${classifierName}" classifier.
Generate a JSON array of regex patterns that would match these inputs deterministically.

Examples:
${examples}

Return a JSON array only, no other text:
[{ "pattern": "regex string", "label": "class name", "confidence": 0.0-1.0 }]

Use case-insensitive patterns. Prefer simple, broad patterns over narrow exact matches.
Ensure all regex strings are valid JavaScript regular expressions.`;

    let added = 0;

    try {
        const raw = await chat(config, [{ role: 'user', content: prompt }], {
            maxTokens: 600,
            temperature: 0,
        });

        const cleaned = raw
            .replace(/^```(?:json)?\n?/m, '')
            .replace(/\n?```$/m, '')
            .trim();

        const patterns = JSON.parse(cleaned) as PatternRow[];

        const insert = db.prepare(
            `INSERT OR IGNORE INTO classifier_patterns
               (classifier_name, pattern, label, confidence, match_count, created_at, source)
             VALUES (?, ?, ?, ?, 0, ?, 'llm')`,
        );

        for (const p of patterns) {
            try {
                /** Validate the regex before persisting — bad regexes would cause runtime errors. */
                new RegExp(p.pattern);
                const result = insert.run(
                    classifierName,
                    p.pattern,
                    p.label,
                    p.confidence,
                    new Date().toISOString(),
                );
                /** INSERT OR IGNORE: count only rows actually written (changes = 0 for duplicates). */
                if (result.changes > 0) added++;
            } catch {
                /** LLM produced an invalid regex — skip. */
            }
        }

        /** Mark fallbacks as processed so they are not re-submitted next run. */
        db.prepare(
            `UPDATE classifier_fallbacks
             SET pattern_used = 'extracted'
             WHERE classifier_name = ? AND pattern_used IS NULL`,
        ).run(classifierName);
    } catch {
        /** If the LLM or JSON parse fails, leave fallbacks unprocessed for next time. */
    }

    return added;
}
