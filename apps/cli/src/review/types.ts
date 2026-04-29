/**
 * Trajectory review pass types.
 *
 * The review pass walks `query_log` per session, decides whether the session
 * looks like a successful task completion, asks an LLM to extract a
 * `ProposedTrajectory`, and (in auto-capture mode) writes it via the existing
 * `captureTrajectory()` path.
 *
 * Types here describe the inputs and outputs of that pipeline. They sit
 * between the raw `query_log` rows and the public `Trajectory*` types in
 * `apps/cli/src/trajectory/types.ts` — translation happens in the orchestrator.
 */

import type { ScopeKind } from '../types/index.js';
import type { TrajectoryOutcome } from '../trajectory/index.js';

/**
 * One row read out of `query_log`, narrowed to what the review pass cares
 * about. The full row has more fields (latency, scope, etc.) — we only project
 * the ones the LLM prompt and the heuristics need.
 */
export type SessionLogRow = {
    tool_name: string;
    query_text: string | null;
    result_count: number | null;
    skill_hit: 0 | 1;
    tokens_spent: number | null;
    timestamp: string;
};

/** All log rows for one session, ordered chronologically (oldest first). */
export type SessionLog = {
    session_id: string;
    rows: SessionLogRow[];
    /** First row's timestamp - the session's start. */
    started_at: string;
    /** Last row's timestamp - the session's most recent activity. */
    ended_at: string;
    /** Sum of skill_hit across all rows. */
    total_skill_hits: number;
    /** Sum of tokens_spent (null entries excluded). */
    total_tokens: number;
    /** First non-null scope encountered, if any - useful as the review's default scope. */
    inferred_scope: { kind: ScopeKind; key: string } | null;
};

/**
 * Outcome of a review pass on one session. Persisted to `session_review` so
 * we don't re-process the same session on every run.
 *   - `extracted`: LLM found a clean trajectory; row exists in sources.
 *   - `no_skill`:  LLM judged the session not worth capturing.
 *   - `failed`:    LLM call or parse threw; review will retry on a future run.
 *   - `skipped`:   Heuristic gate rejected the session (too short, too thin, etc.).
 */
export type ReviewOutcome = 'extracted' | 'no_skill' | 'failed' | 'skipped';

/**
 * What the LLM gives back. Mirrors the shape `captureTrajectory` accepts but
 * stays typed separately so the LLM contract is testable in isolation. The
 * orchestrator translates this into the trajectory module's input.
 */
export type ProposedTrajectory = {
    task: string;
    outcome: TrajectoryOutcome;
    steps: Array<{
        tool: string;
        args: Record<string, unknown>;
        result_summary: string;
        result_ok: boolean;
    }>;
};

/** One session's review outcome plus the trajectory it produced (if any). */
export type ReviewRecord = {
    session_id: string;
    reviewed_at: string;
    outcome: ReviewOutcome;
    trajectory_id: string | null;
    notes: string | null;
};

/** Summary stats returned by `reviewSessions()` so callers can show progress. */
export type ReviewSummary = {
    sessions_inspected: number;
    sessions_extracted: number;
    sessions_no_skill: number;
    sessions_failed: number;
    sessions_skipped: number;
    trajectories_created: string[];
};
