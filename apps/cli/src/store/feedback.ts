/**
 * Append-only feedback log for concepts.
 *
 * Every +1 / -1 vote becomes one row; the concept's `score` is the SUM of
 * `delta` over all rows for that slug. Rows are immutable - they sync clean
 * across devices (no merge conflicts) because two devices producing the same
 * row independently is impossible (autoincrement id is local).
 *
 * `recordFeedback` is the single write entry point: it inserts the row,
 * recomputes the score, and triggers auto-retirement when the cumulative
 * score crosses RETIRE_THRESHOLD. The retire reason on auto-retirement is
 * the most recent negative feedback's reason (so the agent can read why).
 */

import { getDb } from './database.js';
import type { ConceptFeedback } from '../types/index.js';
import { RETIRE_THRESHOLD } from '../types/index.js';
import { updateScore } from './concepts.js';
import { resolveAlias } from './aliases.js';
import { appendJournal } from '../sync/journal.js';

export type RecordFeedbackInput = {
    slug: string;
    delta: -1 | 1;
    reason?: string | null;
    session_id?: string | null;
    device_id?: string | null;
};

export type RecordFeedbackResult = {
    feedback_id: number;
    new_score: number;
    retired: boolean;
};

/**
 * Insert one feedback row, recompute the concept's score, and auto-retire
 * if the new score crosses the threshold. Returns the new score and whether
 * the concept was retired by this call (false if it was already retired).
 */
export function recordFeedback(input: RecordFeedbackInput): RecordFeedbackResult {
    const db = getDb();
    const now = new Date().toISOString();
    const slug = resolveAlias(input.slug);

    /**
     * Insert + journal in a single transaction so concept_feedback and
     * sync_journal stay consistent across crashes. Score recomputation +
     * auto-retire happen after; they're idempotent reads/writes the journal
     * doesn't need to mirror (peer devices apply feedback rows via the same
     * append-only sum, so each device computes score locally from its own
     * feedback table).
     */
    const inserted = db.transaction(() => {
        const result = db
            .prepare(
                `INSERT INTO concept_feedback (concept_slug, delta, reason, session_id, device_id, created_at)
                 VALUES (@slug, @delta, @reason, @session_id, @device_id, @created_at)`,
            )
            .run({
                slug,
                delta: input.delta,
                reason: input.reason ?? null,
                session_id: input.session_id ?? null,
                device_id: input.device_id ?? null,
                created_at: now,
            });

        const scope = db
            .prepare('SELECT scope_kind, scope_key FROM concepts WHERE slug = ?')
            .get(slug) as { scope_kind: string; scope_key: string } | undefined;
        if (scope) {
            appendJournal({
                op: 'feedback',
                entity_id: slug,
                scope_kind: scope.scope_kind as never,
                scope_key: scope.scope_key,
                payload: {
                    concept_slug: slug,
                    delta: input.delta,
                    reason: input.reason ?? null,
                    session_id: input.session_id ?? null,
                },
            });
        }
        return result;
    })();

    const newScore = feedbackTotal(slug);

    /** Auto-retire reason: most recent negative reason, or a generic note. */
    let autoReason: string | null = null;
    if (newScore <= RETIRE_THRESHOLD) {
        autoReason = mostRecentNegativeReason(slug);
    }

    const beforeState = db.prepare('SELECT retired_at FROM concepts WHERE slug = ?').get(slug) as
        | { retired_at: string | null }
        | undefined;
    const wasActive = beforeState ? beforeState.retired_at === null : false;

    updateScore(slug, newScore, autoReason);

    const afterState = db.prepare('SELECT retired_at FROM concepts WHERE slug = ?').get(slug) as
        | { retired_at: string | null }
        | undefined;
    const retiredNow = wasActive && afterState !== undefined && afterState.retired_at !== null;

    return {
        feedback_id: Number(inserted.lastInsertRowid),
        new_score: newScore,
        retired: retiredNow,
    };
}

/** Cumulative score = SUM(delta) for a slug. Returns 0 when no feedback exists. */
export function feedbackTotal(slug: string): number {
    const row = getDb()
        .prepare(
            'SELECT COALESCE(SUM(delta), 0) AS total FROM concept_feedback WHERE concept_slug = ?',
        )
        .get(resolveAlias(slug)) as { total: number };
    return row.total;
}

/** All feedback for a slug, newest first. */
export function listFeedback(slug: string, limit?: number): ConceptFeedback[] {
    const resolved = resolveAlias(slug);
    const sql = limit
        ? 'SELECT * FROM concept_feedback WHERE concept_slug = ? ORDER BY created_at DESC, id DESC LIMIT ?'
        : 'SELECT * FROM concept_feedback WHERE concept_slug = ? ORDER BY created_at DESC, id DESC';
    const rows = (
        limit ? getDb().prepare(sql).all(resolved, limit) : getDb().prepare(sql).all(resolved)
    ) as Array<{
        id: number;
        concept_slug: string;
        delta: number;
        reason: string | null;
        session_id: string | null;
        device_id: string | null;
        created_at: string;
    }>;
    return rows.map((r) => ({
        id: r.id,
        concept_slug: r.concept_slug,
        delta: r.delta as -1 | 1,
        reason: r.reason,
        session_id: r.session_id,
        device_id: r.device_id,
        created_at: r.created_at,
    }));
}

/** Total feedback count across all concepts. */
export function countFeedback(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS count FROM concept_feedback').get() as {
        count: number;
    };
    return row.count;
}

/** Find the most recent feedback row with delta = -1 and a non-null reason. */
function mostRecentNegativeReason(slug: string): string | null {
    const row = getDb()
        .prepare(
            `SELECT reason FROM concept_feedback
             WHERE concept_slug = ? AND delta = -1 AND reason IS NOT NULL
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
        )
        .get(slug) as { reason: string | null } | undefined;
    return row?.reason ?? null;
}
