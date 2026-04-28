/**
 * Trajectory metadata format.
 *
 * A trajectory is an ordered, immutable sequence of tool calls plus context
 * that produced an observable outcome. Captured by an agent after a successful
 * (or failed) task; replayed by a future agent on a similar task to skip
 * exploration.
 *
 * On-disk shape: stored as one `sources` row with `source_type='trajectory'`
 * and the JSON-encoded `TrajectoryMetadata` in the `metadata` column. Each
 * step also lands as one `chunks` row so FTS retrieval works step-level.
 *
 * See `docs/docs-temp/TRAJECTORY-FORMAT.md` for the full spec.
 */

import type { ScopeKind } from '../types/index.js';

/** Bump on breaking changes to TrajectoryMetadata. Migration policy in the spec doc. */
export const TRAJECTORY_FORMAT_VERSION = 1;

export type TrajectoryOutcome = 'success' | 'failure' | 'partial';

/**
 * One step in an agent trajectory - a single tool invocation and its outcome.
 * `args` and `result_summary` are subject to size limits (see validate.ts).
 */
export type TrajectoryStep = {
    /** Step ordinal, 0-indexed. Stable across re-captures of the same trajectory. */
    n: number;
    tool: string;
    args: Record<string, unknown>;
    /** Human-readable summary of what happened. Max 500 chars. */
    result_summary: string;
    /** Did the tool return successfully? */
    result_ok: boolean;
    /** Wall-clock duration in ms; null when the agent didn't measure. */
    elapsed_ms: number | null;
};

export type TrajectoryInputs = {
    /** Verbatim user prompt that started the task, when available. */
    user_prompt?: string;
    /** Files that were in agent context at task start. */
    files_in_context?: string[];
};

export type TrajectoryMetadata = {
    v: typeof TRAJECTORY_FORMAT_VERSION;
    task: string;
    steps: TrajectoryStep[];
    outcome: TrajectoryOutcome;
    /** Free-text agent identifier. Used for analytics, not for routing. */
    agent: string;
    /** Session correlation - lets the review pass group related trajectories. */
    session_id: string;
    total_tokens: number | null;
    total_elapsed_ms: number | null;
    /** Scope at capture time. Sync routing depends on this. */
    scope: { kind: ScopeKind; key: string };
    inputs: TrajectoryInputs | null;
    /** git rev-parse HEAD at capture time, when in a git repo. */
    codebase_revision: string | null;
};

/** Result of `captureTrajectory()`. Surfaces validation diagnostics for the agent. */
export type CaptureResult = {
    source_id: string;
    scope: { kind: ScopeKind; key: string };
    step_count: number;
    /** Per-step truncations applied during validation. */
    truncations: number;
    /** Bytes shed by truncating oversized args. */
    args_bytes_dropped: number;
};

/** Replay drift signals computed at retrieval time. */
export type ReplayCaveat =
    | { type: 'revision_diff'; from: string; to: string; commits_behind: number | null }
    | { type: 'missing_file'; step: number; file_path: string }
    | { type: 'failure_outcome'; outcome: 'failure' | 'partial' };

export type ReplayMatch = {
    source_id: string;
    score: number;
    metadata: TrajectoryMetadata;
    caveats: ReplayCaveat[];
};

export type FindReplayResult = {
    found: boolean;
    /** Highest-scoring active trajectory. */
    skill: ReplayMatch | null;
    /** Other candidates considered, ordered by score. */
    candidates: ReplayMatch[];
};
