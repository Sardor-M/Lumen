import { getDb } from './database.js';
import type { ScopeKind } from '../types/index.js';

/**
 * One telemetry row written by every retrieval / write call. The five v13
 * columns are optional - existing callers that omit them get null / default 0
 * and continue to work unchanged. The new fields drive the
 * exploration-cost-avoided aggregation surfaced in `profile.learned`.
 */
type QueryLogEntry = {
    tool_name: string;
    query_text: string | null;
    result_count: number | null;
    latency_ms: number | null;
    session_id: string | null;
    /** Estimated tokens consumed by this call. Null when unknown. */
    tokens_spent?: number | null;
    /** 1 when the call returned a known skill (concept hit), 0 otherwise. */
    skill_hit?: 0 | 1;
    /** Position of this call within its session's tool-call sequence. */
    exploration_depth?: number | null;
    /** Scope routing context, when the caller had one. */
    scope_kind?: ScopeKind | null;
    scope_key?: string | null;
};

type FrequentTopic = {
    query_text: string;
    count: number;
};

type RecentQuery = {
    tool_name: string;
    query_text: string | null;
    timestamp: string;
};

export function logQuery(entry: QueryLogEntry): void {
    getDb()
        .prepare(
            `INSERT INTO query_log (
                tool_name, query_text, result_count, latency_ms, session_id,
                tokens_spent, skill_hit, exploration_depth, scope_kind, scope_key
             )
             VALUES (
                @tool_name, @query_text, @result_count, @latency_ms, @session_id,
                @tokens_spent, @skill_hit, @exploration_depth, @scope_kind, @scope_key
             )`,
        )
        .run({
            tool_name: entry.tool_name,
            query_text: entry.query_text,
            result_count: entry.result_count,
            latency_ms: entry.latency_ms,
            session_id: entry.session_id,
            tokens_spent: entry.tokens_spent ?? null,
            skill_hit: entry.skill_hit ?? 0,
            exploration_depth: entry.exploration_depth ?? null,
            scope_kind: entry.scope_kind ?? null,
            scope_key: entry.scope_key ?? null,
        });
}

export function recentQueries(limit = 20): RecentQuery[] {
    return getDb()
        .prepare(
            `SELECT tool_name, query_text, timestamp
             FROM query_log
             ORDER BY timestamp DESC
             LIMIT ?`,
        )
        .all(limit) as RecentQuery[];
}

export function frequentTopics(limit = 10): FrequentTopic[] {
    return getDb()
        .prepare(
            `SELECT query_text, COUNT(*) as count
             FROM query_log
             WHERE query_text IS NOT NULL AND query_text != ''
             GROUP BY query_text
             ORDER BY count DESC
             LIMIT ?`,
        )
        .all(limit) as FrequentTopic[];
}

export function queryCountByTool(): Record<string, number> {
    const rows = getDb()
        .prepare(
            `SELECT tool_name, COUNT(*) as count
             FROM query_log
             GROUP BY tool_name
             ORDER BY count DESC`,
        )
        .all() as Array<{ tool_name: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
        result[row.tool_name] = row.count;
    }
    return result;
}

/**
 * Per-scope summary of exploration cost avoided. One row per active scope,
 * suitable for `profile.learned.by_scope`.
 */
export type ScopeTelemetry = {
    scope_kind: ScopeKind;
    scope_key: string;
    label: string;
    sessions: number;
    hit_rate: number;
    estimated_savings_tokens: number;
};

/**
 * Aggregate exploration-cost-avoided telemetry over the last `days` window.
 *
 * Methodology:
 *   1. Group rows by `session_id`. A session is "skill-aided" if at least one
 *      logged call had `skill_hit = 1`; otherwise it counted as "exploration".
 *   2. Hit rate = sessions-with-at-least-one-hit / total sessions.
 *   3. Baseline tokens = mean tokens_spent per exploration session.
 *   4. With-skill tokens = mean tokens_spent per skill-aided session.
 *   5. Savings = (baseline - with_skill) * skill-aided session count.
 *      Clamped at 0 (never report negative savings).
 *   6. USD estimate uses a conservative blended rate; document the rate so
 *      callers can override if they price differently.
 *
 * Empty windows return zeros (no division by zero, no NaN). Sessions with
 * null tokens_spent are excluded from the token aggregations but still count
 * toward hit_rate.
 */
export type ExplorationCostAvoided = {
    days: number;
    total_sessions: number;
    skill_aided_sessions: number;
    exploration_sessions: number;
    hit_rate: number;
    baseline_tokens: number;
    with_skill_tokens: number;
    estimated_savings_tokens: number;
    estimated_savings_usd: number;
    by_scope: ScopeTelemetry[];
};

/**
 * Conservative blended rate (input + output mixed) for cost estimates.
 * Order-of-magnitude correct for current Anthropic / OpenAI mid-tier models.
 */
const USD_PER_1K_TOKENS = 0.003;

export function explorationCostAvoided(days: number): ExplorationCostAvoided {
    const db = getDb();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    /** Per-session totals, with skill-hit and token-sum aggregates. */
    type SessionRow = {
        session_id: string;
        any_hit: number;
        token_total: number | null;
        scope_kind: string | null;
        scope_key: string | null;
    };
    const sessionRows = db
        .prepare(
            `SELECT session_id,
                    MAX(skill_hit) AS any_hit,
                    SUM(tokens_spent) AS token_total,
                    /** First non-null scope wins for the session. */
                    MAX(scope_kind) AS scope_kind,
                    MAX(scope_key)  AS scope_key
             FROM query_log
             WHERE session_id IS NOT NULL
               AND timestamp >= ?
             GROUP BY session_id`,
        )
        .all(since) as SessionRow[];

    const total = sessionRows.length;
    let skillAided = 0;
    let exploration = 0;
    let baselineTokenSum = 0;
    let baselineCount = 0;
    let withSkillTokenSum = 0;
    let withSkillCount = 0;

    /** Per-scope aggregator. */
    type ScopeAccum = {
        sessions: number;
        hits: number;
        tokensWith: number;
        tokensBaseline: number;
        countWith: number;
        countBaseline: number;
    };
    const byScopeMap = new Map<string, ScopeAccum & { kind: ScopeKind; key: string }>();

    for (const row of sessionRows) {
        const isHit = row.any_hit === 1;
        if (isHit) skillAided++;
        else exploration++;

        if (row.token_total !== null) {
            if (isHit) {
                withSkillTokenSum += row.token_total;
                withSkillCount++;
            } else {
                baselineTokenSum += row.token_total;
                baselineCount++;
            }
        }

        if (row.scope_kind !== null && row.scope_key !== null) {
            const k = `${row.scope_kind}:${row.scope_key}`;
            let accum = byScopeMap.get(k);
            if (!accum) {
                accum = {
                    kind: row.scope_kind as ScopeKind,
                    key: row.scope_key,
                    sessions: 0,
                    hits: 0,
                    tokensWith: 0,
                    tokensBaseline: 0,
                    countWith: 0,
                    countBaseline: 0,
                };
                byScopeMap.set(k, accum);
            }
            accum.sessions++;
            if (isHit) accum.hits++;
            if (row.token_total !== null) {
                if (isHit) {
                    accum.tokensWith += row.token_total;
                    accum.countWith++;
                } else {
                    accum.tokensBaseline += row.token_total;
                    accum.countBaseline++;
                }
            }
        }
    }

    const hitRate = total > 0 ? skillAided / total : 0;
    const baseline = baselineCount > 0 ? baselineTokenSum / baselineCount : 0;
    const withSkill = withSkillCount > 0 ? withSkillTokenSum / withSkillCount : 0;
    const perSessionSavings = Math.max(0, baseline - withSkill);
    const savings = perSessionSavings * skillAided;

    const byScope: ScopeTelemetry[] = [];
    for (const accum of byScopeMap.values()) {
        const sBaseline = accum.countBaseline > 0 ? accum.tokensBaseline / accum.countBaseline : 0;
        const sWith = accum.countWith > 0 ? accum.tokensWith / accum.countWith : 0;
        const sSavings = Math.max(0, sBaseline - sWith) * accum.hits;
        byScope.push({
            scope_kind: accum.kind,
            scope_key: accum.key,
            label: `${accum.kind}:${accum.key}`,
            sessions: accum.sessions,
            hit_rate: accum.sessions > 0 ? accum.hits / accum.sessions : 0,
            estimated_savings_tokens: Math.round(sSavings),
        });
    }
    byScope.sort((a, b) => b.estimated_savings_tokens - a.estimated_savings_tokens);

    return {
        days,
        total_sessions: total,
        skill_aided_sessions: skillAided,
        exploration_sessions: exploration,
        hit_rate: hitRate,
        baseline_tokens: Math.round(baseline),
        with_skill_tokens: Math.round(withSkill),
        estimated_savings_tokens: Math.round(savings),
        estimated_savings_usd: Math.round((savings / 1000) * USD_PER_1K_TOKENS * 100) / 100,
        by_scope: byScope,
    };
}
