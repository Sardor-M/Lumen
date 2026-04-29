/**
 * Session walker for the trajectory review pass.
 *
 * Reads `query_log`, groups rows by `session_id`, and decides which
 * sessions are worth handing to the LLM extractor. The decision rules are
 * conservative — false negatives (skipping a real task) are cheap, false
 * positives (extracting from noise) burn LLM tokens.
 */

import { getDb } from '../store/database.js';
import { getStmt } from '../store/prepared.js';
import type { ScopeKind } from '../types/index.js';
import type { SessionLog, SessionLogRow } from './types.js';

/**
 * Minimum number of distinct tool calls before a session is even considered.
 * Below this threshold the session is too short to be a recognizable task.
 */
export const MIN_SESSION_TOOL_CALLS = 3;

/**
 * Maximum age (ms) for a candidate session. Older sessions are skipped to
 * keep the review pass cheap and to avoid re-processing the entire history
 * on every run. Default = 14 days.
 */
export const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type CandidateSessionsOptions = {
    /** Only consider sessions whose most recent row is newer than this. Default: 14 days ago. */
    sinceMs?: number;
    /** Cap on number of candidate sessions returned. Default: 50. */
    limit?: number;
    /** Only consider sessions in this scope. */
    scope?: { kind: ScopeKind; key: string };
};

/**
 * List session IDs that look like candidates for review.
 * Excludes sessions already in `session_review` (idempotent), sessions with
 * fewer than MIN_SESSION_TOOL_CALLS rows, and sessions older than the cutoff.
 */
export function listCandidateSessions(opts: CandidateSessionsOptions = {}): string[] {
    const limit = opts.limit ?? 50;
    const since = new Date(Date.now() - (opts.sinceMs ?? DEFAULT_MAX_AGE_MS)).toISOString();

    const scopeFilter = opts.scope ? 'AND ql.scope_kind = ? AND ql.scope_key = ?' : '';
    const sql = `
        SELECT ql.session_id, COUNT(*) AS tool_calls, MAX(ql.timestamp) AS last_seen
        FROM query_log ql
        LEFT JOIN session_review sr ON sr.session_id = ql.session_id
        WHERE ql.session_id IS NOT NULL
          AND sr.session_id IS NULL
          AND ql.timestamp >= ?
          ${scopeFilter}
        GROUP BY ql.session_id
        HAVING tool_calls >= ?
        ORDER BY last_seen DESC
        LIMIT ?
    `;

    const params: unknown[] = opts.scope
        ? [since, opts.scope.kind, opts.scope.key, MIN_SESSION_TOOL_CALLS, limit]
        : [since, MIN_SESSION_TOOL_CALLS, limit];

    const rows = getStmt(getDb(), sql).all(...params) as Array<{
        session_id: string;
        tool_calls: number;
        last_seen: string;
    }>;
    return rows.map((r) => r.session_id);
}

/**
 * Hydrate one session into a SessionLog. Returns null if the session has no
 * rows (rare but possible if the session was deleted between listing and load).
 */
export function loadSessionLog(sessionId: string): SessionLog | null {
    const rows = getStmt(
        getDb(),
        `SELECT tool_name, query_text, result_count, skill_hit, tokens_spent, timestamp,
                scope_kind, scope_key
         FROM query_log
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`,
    ).all(sessionId) as Array<
        SessionLogRow & { scope_kind: string | null; scope_key: string | null }
    >;
    if (rows.length === 0) return null;

    let totalHits = 0;
    let totalTokens = 0;
    let inferredScope: { kind: ScopeKind; key: string } | null = null;
    for (const r of rows) {
        if (r.skill_hit === 1) totalHits++;
        if (r.tokens_spent !== null) totalTokens += r.tokens_spent;
        if (!inferredScope && r.scope_kind && r.scope_key) {
            inferredScope = { kind: r.scope_kind as ScopeKind, key: r.scope_key };
        }
    }

    return {
        session_id: sessionId,
        rows: rows.map((r) => ({
            tool_name: r.tool_name,
            query_text: r.query_text,
            result_count: r.result_count,
            skill_hit: r.skill_hit,
            tokens_spent: r.tokens_spent,
            timestamp: r.timestamp,
        })),
        started_at: rows[0].timestamp,
        ended_at: rows[rows.length - 1].timestamp,
        total_skill_hits: totalHits,
        total_tokens: totalTokens,
        inferred_scope: inferredScope,
    };
}

/**
 * Heuristic gate run before the LLM call. Returns the reason to skip, or
 * null if the session should be reviewed.
 *
 * These rules trade recall for cost: when in doubt, skip. The LLM is
 * expensive; missing a real task is fine because the user can manually
 * `capture_trajectory` if they care.
 */
export function shouldSkip(session: SessionLog): string | null {
    if (session.rows.length < MIN_SESSION_TOOL_CALLS) {
        return `too few tool calls (${session.rows.length} < ${MIN_SESSION_TOOL_CALLS})`;
    }
    /**
     * Sessions whose only tool calls are search-type ones (no edits, no shell)
     * usually represent browsing, not task completion. Skip them.
     */
    const writeLikeTools = new Set([
        'add',
        'edit',
        'write',
        'bash',
        'capture',
        'capture_trajectory',
        'compile',
    ]);
    const hasWriteLike = session.rows.some((r) => writeLikeTools.has(r.tool_name));
    if (!hasWriteLike) {
        return 'no write-like tool calls (read-only browsing)';
    }
    return null;
}
