/**
 * Public review module.
 *
 * The orchestrator (`reviewSessions`) walks unreviewed candidate sessions,
 * runs each through the heuristic gate then the LLM extractor, persists the
 * outcome to `session_review`, and (when `autoCapture: true`) writes any
 * extracted trajectory via `captureTrajectory()`.
 *
 * Test usability: the chat function is injected, so tests pass a mock and
 * production callers pass `chatJson` from the LLM client. The orchestrator
 * itself is a pure dependency-graph composition — schema, walker, extractor,
 * store all isolated.
 */

import { chatJson } from '../llm/client.js';
import { captureTrajectory } from '../trajectory/index.js';
import { recordReview } from '../store/session-reviews.js';
import { loadSessionLog, listCandidateSessions, shouldSkip } from './session.js';
import { extractTrajectory } from './extractor.js';
import type { LumenConfig, ScopeKind } from '../types/index.js';
import type { ChatJsonFn } from './extractor.js';
import type { ReviewSummary } from './types.js';

export type ReviewSessionsOptions = {
    /** Window of recency. Default 14 days. */
    sinceMs?: number;
    /** Cap on candidates per run. Default 50. */
    limit?: number;
    /** Restrict to a specific scope. */
    scope?: { kind: ScopeKind; key: string };
    /**
     * When true, automatically `captureTrajectory()` on every successful
     * extraction. When false, the review is recorded but no trajectory
     * row is written - useful for dry-runs and human-in-the-loop flows.
     * Default: false (safer).
     */
    autoCapture?: boolean;
    /** Inject a different chat function (mainly for tests). */
    chat?: ChatJsonFn;
    /** Working directory passed through to captureTrajectory(). */
    cwd?: string;
};

export async function reviewSessions(
    config: LumenConfig,
    options: ReviewSessionsOptions = {},
): Promise<ReviewSummary> {
    const chat = options.chat ?? chatJson;

    const summary: ReviewSummary = {
        sessions_inspected: 0,
        sessions_extracted: 0,
        sessions_no_skill: 0,
        sessions_failed: 0,
        sessions_skipped: 0,
        trajectories_created: [],
    };

    const candidates = listCandidateSessions({
        sinceMs: options.sinceMs,
        limit: options.limit,
        scope: options.scope,
    });

    for (const sessionId of candidates) {
        summary.sessions_inspected++;
        const session = loadSessionLog(sessionId);
        if (!session) {
            recordReview({ session_id: sessionId, outcome: 'skipped', notes: 'session log unavailable' });
            summary.sessions_skipped++;
            continue;
        }

        const skipReason = shouldSkip(session);
        if (skipReason) {
            recordReview({ session_id: sessionId, outcome: 'skipped', notes: skipReason });
            summary.sessions_skipped++;
            continue;
        }

        const result = await extractTrajectory(session, config, chat);

        if (result.kind === 'failed') {
            recordReview({ session_id: sessionId, outcome: 'failed', notes: result.reason });
            summary.sessions_failed++;
            continue;
        }

        if (result.kind === 'no_skill') {
            recordReview({ session_id: sessionId, outcome: 'no_skill', notes: result.reason });
            summary.sessions_no_skill++;
            continue;
        }

        /** kind === 'extracted'. */
        if (!options.autoCapture) {
            /**
             * Dry-run mode - record the proposed trajectory's task as the note
             * so the user can inspect what would have been captured. The
             * `trajectory_id` stays null since nothing was written.
             */
            recordReview({
                session_id: sessionId,
                outcome: 'extracted',
                trajectory_id: null,
                notes: `proposed: ${result.trajectory.task}`,
            });
            summary.sessions_extracted++;
            continue;
        }

        /** Auto-capture path. */
        try {
            const captured = captureTrajectory({
                task: result.trajectory.task,
                outcome: result.trajectory.outcome,
                steps: result.trajectory.steps.map((s) => ({
                    tool: s.tool,
                    args: s.args,
                    result_summary: s.result_summary,
                    result_ok: s.result_ok,
                    elapsed_ms: null,
                })),
                agent: 'review-pass',
                session_id: sessionId,
                scope: session.inferred_scope ?? options.scope,
                cwd: options.cwd,
            });
            recordReview({
                session_id: sessionId,
                outcome: 'extracted',
                trajectory_id: captured.source_id,
                notes: `auto-captured: ${result.trajectory.task}`,
            });
            summary.sessions_extracted++;
            summary.trajectories_created.push(captured.source_id);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            recordReview({
                session_id: sessionId,
                outcome: 'failed',
                notes: `captureTrajectory threw: ${reason}`,
            });
            summary.sessions_failed++;
        }
    }

    return summary;
}

export {
    extractTrajectory,
    type ChatJsonFn,
    type ExtractTrajectoryResult,
    type ExtractOptions,
} from './extractor.js';
export {
    loadSessionLog,
    listCandidateSessions,
    shouldSkip,
    MIN_SESSION_TOOL_CALLS,
    DEFAULT_MAX_AGE_MS,
} from './session.js';
export type {
    SessionLog,
    SessionLogRow,
    ProposedTrajectory,
    ReviewOutcome,
    ReviewRecord,
    ReviewSummary,
} from './types.js';
