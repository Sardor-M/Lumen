/**
 * Trajectory capture path.
 *
 * Stores a successful (or failed) tool-call sequence as a replayable skill.
 * Pipeline:
 *   1. Resolve scope (defaults to current cwd's codebase scope).
 *   2. Detect git revision when in a repo.
 *   3. Validate + truncate per size limits.
 *   4. Insert one source row (source_type='trajectory').
 *   5. Insert per-step chunks so FTS retrieval works step-level.
 *   6. Touch the scopes registry so `lumen scope list` surfaces it.
 *
 * The trajectory's `task` becomes the source title. The full metadata JSON
 * is stored both in `sources.content` (for FTS via the summary chunk) and in
 * `sources.metadata` (for structured replay).
 */

import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { upsertScope } from '../store/scopes.js';
import { resolveCodebase } from '../scope/index.js';
import { readGitRevision } from './git.js';
import { shortId, contentHash } from '../utils/hash.js';
import { estimateTokens } from '../compress/tokenizer.js';
import { appendJournal } from '../sync/journal.js';
import { getDb } from '../store/database.js';
import type { Chunk, ScopeKind } from '../types/index.js';
import type {
    CaptureResult,
    TrajectoryInputs,
    TrajectoryMetadata,
    TrajectoryOutcome,
    TrajectoryStep,
} from './types.js';
import { TRAJECTORY_FORMAT_VERSION } from './types.js';
import { validateTrajectory } from './validate.js';

export type CaptureTrajectoryInput = {
    task: string;
    steps: Array<Omit<TrajectoryStep, 'n'> & { n?: number }>;
    outcome: TrajectoryOutcome;
    /** Defaults to `'unknown'` when not provided. */
    agent?: string;
    /** Defaults to `'session-' + Date.now()` when not provided. */
    session_id?: string;
    total_tokens?: number | null;
    total_elapsed_ms?: number | null;
    /** Defaults to `resolveCodebase(cwd)` when not provided. */
    scope?: { kind: ScopeKind; key: string };
    inputs?: TrajectoryInputs;
    /** Working directory used to resolve scope and git revision. Defaults to process.cwd(). */
    cwd?: string;
};

export function captureTrajectory(input: CaptureTrajectoryInput): CaptureResult {
    const cwd = input.cwd ?? process.cwd();
    const scope = input.scope ?? resolveCodebase(cwd);
    const session_id = input.session_id ?? `session-${Date.now()}`;
    const agent = input.agent ?? 'unknown';
    const codebase_revision = readGitRevision(cwd);

    const steps: TrajectoryStep[] = input.steps.map((s, i) => ({
        n: s.n ?? i,
        tool: s.tool,
        args: s.args,
        result_summary: s.result_summary,
        result_ok: s.result_ok,
        elapsed_ms: s.elapsed_ms ?? null,
    }));

    const rawMetadata: TrajectoryMetadata = {
        v: TRAJECTORY_FORMAT_VERSION,
        task: input.task,
        steps,
        outcome: input.outcome,
        agent,
        session_id,
        total_tokens: input.total_tokens ?? null,
        total_elapsed_ms: input.total_elapsed_ms ?? null,
        scope: { kind: scope.kind, key: scope.key },
        inputs: input.inputs ?? null,
        codebase_revision,
    };

    const { metadata, diagnostics } = validateTrajectory(rawMetadata);

    const metadataJson = JSON.stringify(metadata);
    const source_id = shortId(`trajectory:${session_id}:${metadata.task}:${metadataJson}`);
    const now = new Date().toISOString();

    /** Word count is approximate; sums step result_summary lengths. */
    const wordCount = metadata.steps.reduce(
        (sum, s) => sum + s.result_summary.split(/\s+/).filter(Boolean).length,
        0,
    );

    /**
     * Source insert + chunks insert + journal append in a single transaction.
     * Pulls on a peer device replay this trajectory by inserting source +
     * chunks from the journal payload — so the payload carries the full
     * metadata, including pre-truncated steps.
     */
    const captureAndJournal = getDb().transaction(() => {
        insertSource({
            id: source_id,
            title: metadata.task,
            url: null,
            content: metadataJson,
            content_hash: contentHash(metadataJson),
            source_type: 'trajectory',
            added_at: now,
            compiled_at: null,
            word_count: wordCount,
            language: null,
            metadata: metadataJson,
            scope_kind: scope.kind,
            scope_key: scope.key,
        });

        /**
         * Touch the scopes registry so the codebase appears in `lumen scope list`.
         * Don't try to read `scope.label` here - the input scope from the agent only
         * carries (kind, key); only the resolver-produced scope has a label, and we
         * deliberately drop it to keep this code path uniform.
         */
        if (scope.kind === 'codebase') {
            upsertScope({ kind: scope.kind, key: scope.key });
        }

        insertChunks(buildTrajectoryChunks(source_id, metadata));

        appendJournal({
            op: 'trajectory',
            entity_id: source_id,
            scope_kind: scope.kind,
            scope_key: scope.key,
            payload: {
                source_id,
                metadata: metadata as unknown as Record<string, unknown>,
            },
        });
    });
    captureAndJournal();

    return {
        source_id,
        scope: { kind: scope.kind, key: scope.key },
        step_count: metadata.steps.length,
        truncations: diagnostics.truncations,
        args_bytes_dropped: diagnostics.args_bytes_dropped,
    };
}

/**
 * One summary chunk at position 0 (task + outcome + agent for top-level matches),
 * plus one chunk per step for fine-grained step-level retrieval.
 *
 * Exported so Tier 5e's `applyTrajectory` can replay the same chunk shape on
 * the destination device — the journal carries metadata, not chunks, so the
 * receiver rebuilds them deterministically.
 */
export function buildTrajectoryChunks(source_id: string, metadata: TrajectoryMetadata): Chunk[] {
    const chunks: Chunk[] = [];

    const summary =
        `Task: ${metadata.task}\n` +
        `Outcome: ${metadata.outcome}\n` +
        `Agent: ${metadata.agent}\n` +
        `Steps: ${metadata.steps.length}`;
    chunks.push({
        id: shortId(`${source_id}:summary`),
        source_id,
        content: summary,
        content_hash: contentHash(summary),
        chunk_type: 'paragraph',
        heading: 'Trajectory summary',
        position: 0,
        token_count: estimateTokens(summary),
    });

    for (const step of metadata.steps) {
        const argsRendered = renderArgsForFts(step.args);
        const body =
            `step ${step.n}: ${step.tool}(${argsRendered})\n` +
            `result: ${step.result_ok ? 'ok' : 'error'} - ${step.result_summary}`;
        chunks.push({
            id: shortId(`${source_id}:${step.n}:${body}`),
            source_id,
            content: body,
            content_hash: contentHash(body),
            chunk_type: 'paragraph',
            heading: `Step ${step.n}: ${step.tool}`,
            position: step.n + 1,
            token_count: estimateTokens(body),
        });
    }

    return chunks;
}

/** Render args as a compact "k=v" string for FTS, capped to keep chunks small. */
function renderArgsForFts(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
        const rendered = typeof v === 'string' ? v : JSON.stringify(v);
        parts.push(`${k}=${rendered}`);
    }
    const joined = parts.join(' ');
    return joined.length > 200 ? joined.slice(0, 197) + '...' : joined;
}
