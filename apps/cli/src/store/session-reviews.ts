/**
 * CRUD for `session_review` rows.
 *
 * One row per session, written by the review pass after deciding whether to
 * extract a trajectory. The write path is `recordReview()`; reads exist for
 * the CLI summary view and for the orchestrator's idempotency check (we
 * never re-review a session that already has a row).
 */

import { getDb } from './database.js';
import { getStmt } from './prepared.js';
import type { ReviewOutcome, ReviewRecord } from '../review/types.js';

/**
 * Insert or replace a review row. Idempotent: re-running the review pass on
 * the same session updates the outcome (e.g. `failed` → `extracted` after
 * an LLM retry). Trajectories created on previous runs are NOT cleaned up;
 * that's the orchestrator's responsibility.
 */
export function recordReview(input: {
    session_id: string;
    outcome: ReviewOutcome;
    trajectory_id?: string | null;
    notes?: string | null;
}): void {
    const now = new Date().toISOString();
    getStmt(
        getDb(),
        `INSERT INTO session_review (session_id, reviewed_at, outcome, trajectory_id, notes)
         VALUES (@session_id, @reviewed_at, @outcome, @trajectory_id, @notes)
         ON CONFLICT(session_id) DO UPDATE SET
           reviewed_at   = @reviewed_at,
           outcome       = @outcome,
           trajectory_id = @trajectory_id,
           notes         = @notes`,
    ).run({
        session_id: input.session_id,
        reviewed_at: now,
        outcome: input.outcome,
        trajectory_id: input.trajectory_id ?? null,
        notes: input.notes ?? null,
    });
}

export function getReview(sessionId: string): ReviewRecord | null {
    const row = getStmt(getDb(), 'SELECT * FROM session_review WHERE session_id = ?').get(
        sessionId,
    ) as ReviewRecord | undefined;
    return row ?? null;
}

/** All reviews newest-first. */
export function listReviews(limit?: number): ReviewRecord[] {
    const sql = limit
        ? 'SELECT * FROM session_review ORDER BY reviewed_at DESC LIMIT ?'
        : 'SELECT * FROM session_review ORDER BY reviewed_at DESC';
    const rows = (
        limit ? getStmt(getDb(), sql).all(limit) : getStmt(getDb(), sql).all()
    ) as ReviewRecord[];
    return rows;
}

export function countReviews(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS count FROM session_review').get() as {
        count: number;
    };
    return row.count;
}
