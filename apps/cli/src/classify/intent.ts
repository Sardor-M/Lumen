import { getDb } from '../store/database.js';
import { chat } from '../llm/client.js';
import type { QueryIntent, LumenConfig } from '../types/index.js';

/** Built-in deterministic patterns — expanded over time via learned DB patterns. */
const DEFAULT_PATTERNS: { pattern: RegExp; label: QueryIntent }[] = [
    { pattern: /^(who|what) is\s+/i, label: 'entity_lookup' },
    { pattern: /^(tell me about|explain|describe)\s+/i, label: 'entity_lookup' },
    { pattern: /path (from|between)\s+/i, label: 'graph_path' },
    { pattern: /how (does|do|is).+(connect|relate|link)/i, label: 'graph_path' },
    { pattern: /(related to|neighbors of|connected to)\s+/i, label: 'neighborhood' },
    { pattern: /(what|when).+(happen|occur).+(in|on|during)/i, label: 'temporal' },
    { pattern: /(timeline|history|chronology) of/i, label: 'temporal' },
    {
        pattern: /(what (have|did) i (say|said|write|wrote|note|noted)|my (notes|thoughts) on)/i,
        label: 'originals',
    },
];

const VALID_INTENTS = new Set<QueryIntent>([
    'entity_lookup',
    'graph_path',
    'neighborhood',
    'temporal',
    'originals',
    'hybrid_search',
]);

/**
 * Classify query intent.
 * Priority: (1) learned DB patterns → (2) built-in patterns → (3) LLM fallback.
 * LLM fallbacks are logged to classifier_fallbacks for future pattern extraction.
 */
export async function classifyIntent(query: string, config: LumenConfig): Promise<QueryIntent> {
    const db = getDb();

    /** 1. Try patterns learned from past LLM decisions (highest confidence first). */
    const learned = db
        .prepare(
            `SELECT pattern, label FROM classifier_patterns
             WHERE classifier_name = 'intent'
             ORDER BY confidence DESC, match_count DESC`,
        )
        .all() as { pattern: string; label: string }[];

    for (const row of learned) {
        try {
            if (new RegExp(row.pattern, 'i').test(query)) {
                db.prepare(
                    `UPDATE classifier_patterns
                     SET match_count = match_count + 1
                     WHERE classifier_name = 'intent' AND pattern = ?`,
                ).run(row.pattern);
                return row.label as QueryIntent;
            }
        } catch {
            /** Invalid stored regex — skip. */
        }
    }

    /** 2. Built-in deterministic patterns (no DB write needed). */
    for (const { pattern, label } of DEFAULT_PATTERNS) {
        if (pattern.test(query)) return label;
    }

    /** 3. LLM fallback — cheapest possible call. */
    return classifyWithLlm(query, config);
}

async function classifyWithLlm(query: string, config: LumenConfig): Promise<QueryIntent> {
    const prompt = `Classify this search query into exactly one category:
- entity_lookup: asking what/who a specific thing is
- graph_path: asking how two concepts connect or relate
- neighborhood: asking what is related to or near a concept
- temporal: asking about events or history over time
- originals: asking about the user's own notes or thinking
- hybrid_search: any other information-seeking query

Query: "${query}"

Respond with ONLY the category name, nothing else.`;

    let label: QueryIntent = 'hybrid_search';

    try {
        const raw = await chat(config, [{ role: 'user', content: prompt }], {
            maxTokens: 20,
            temperature: 0,
        });
        const candidate = raw.trim().toLowerCase();
        if (VALID_INTENTS.has(candidate as QueryIntent)) {
            label = candidate as QueryIntent;
        }
    } catch {
        label = 'hybrid_search';
    }

    /** Log for future pattern extraction. */
    getDb()
        .prepare(
            `INSERT INTO classifier_fallbacks
               (classifier_name, input, llm_label, created_at)
             VALUES ('intent', ?, ?, ?)`,
        )
        .run(query, label, new Date().toISOString());

    return label;
}

/** Snapshot of classifier performance for the status command. */
export type ClassifierStats = {
    pattern_hits: number;
    llm_fallbacks: number;
    total: number;
    deterministic_pct: number;
    learned_patterns: number;
};

export function classifierStats(): ClassifierStats {
    const db = getDb();

    const patternHits =
        (
            db
                .prepare(
                    `SELECT COALESCE(SUM(match_count), 0) AS n
                     FROM classifier_patterns WHERE classifier_name = 'intent'`,
                )
                .get() as { n: number }
        ).n ?? 0;

    const llmFallbacks = (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM classifier_fallbacks
                 WHERE classifier_name = 'intent'`,
            )
            .get() as { n: number }
    ).n;

    const learnedPatterns = (
        db
            .prepare(
                `SELECT COUNT(*) AS n FROM classifier_patterns
                 WHERE classifier_name = 'intent'`,
            )
            .get() as { n: number }
    ).n;

    const total = patternHits + llmFallbacks;

    return {
        pattern_hits: patternHits,
        llm_fallbacks: llmFallbacks,
        total,
        deterministic_pct: total > 0 ? Math.round((patternHits / total) * 100) : 0,
        learned_patterns: learnedPatterns,
    };
}
