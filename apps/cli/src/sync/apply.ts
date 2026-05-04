/**
 * Tier 5e — apply rules.
 *
 * Walks `pulled_at IS NOT NULL AND applied_at IS NULL` rows from `sync_journal`
 * and translates each into a local store mutation. Each per-op handler writes
 * direct SQL that does NOT call into the journaling mutators (Option B from
 * TIER-5E-APPLY-RULES.md) — otherwise applying a pulled entry would generate
 * a fresh journal row that would then push back to the relay and bounce
 * across the device cluster forever.
 *
 * Per-entry transactional boundary: each entry's apply + `markApplied` runs
 * inside a single `db.transaction()`. If apply throws, the markApplied rolls
 * back too, so the next `applyPending` call retries the entry. If apply
 * succeeds and markApplied succeeds, both commit together — no partial state.
 *
 * Idempotency by op:
 *   - concept_create — INSERT OR IGNORE on slug PK
 *   - trajectory     — INSERT OR IGNORE on source PK (content-hashed source_id)
 *   - feedback       — INSERT OR IGNORE on the partial UNIQUE INDEX over sync_id
 *   - truth_update   — existence check on `concept_truth_history.superseded_by`
 *                      (when winning) or on (slug, updated_at, device_id, truth)
 *                      (when losing)
 *   - retire         — COALESCE so re-apply doesn't overwrite the original timestamp
 *
 * Ordering: `listUnapplied` returns rows ordered by `sync_id ASC`. Because
 * sync_ids are UUIDv7-shaped (timestamp-prefixed), this approximates causal
 * order: a `concept_create` for slug X arrives before a `feedback` for X
 * from the same device. Cross-device clock skew can violate this; out-of-
 * order entries fail per-entry (FK or "concept not found") and stay
 * `applied_at = NULL` until the prerequisite arrives on a later cycle.
 */

import { getDb } from '../store/database.js';
import { feedbackTotal } from '../store/feedback.js';
import { updateScore } from '../store/concepts.js';
import { insertSource } from '../store/sources.js';
import { insertChunks } from '../store/chunks.js';
import { upsertScope } from '../store/scopes.js';
import { contentHash } from '../utils/hash.js';
import { buildTrajectoryChunks } from '../trajectory/capture.js';
import type { TrajectoryMetadata } from '../trajectory/types.js';
import { listUnapplied, markApplied } from './journal.js';
import type {
    ConceptCreatePayload,
    FeedbackPayload,
    JournalEntry,
    JournalOp,
    RetirePayload,
    TrajectoryPayload,
    TruthUpdatePayload,
} from './types.js';

const DEFAULT_BATCH_LIMIT = 200;

export type ApplyOptions = {
    /** Max entries to process per call. Default 200. */
    limit?: number;
};

export type ApplyFailure = {
    sync_id: string;
    op: JournalOp;
    reason: string;
};

export type ApplyResult = {
    applied: number;
    failed: ApplyFailure[];
    /** Per-op success counts. Useful for `lumen sync status` and the CLI report. */
    by_op: Partial<Record<JournalOp, number>>;
};

/**
 * Walk pending pulled entries and apply each via the per-op handler.
 *
 * Returns counts; never throws. A handler that throws is captured into
 * `failed[]` and the entry stays `applied_at = NULL` for retry on the next
 * call. That's how out-of-order arrivals (feedback before its concept_create)
 * resolve themselves.
 */
export function applyPending(opts: ApplyOptions = {}): ApplyResult {
    const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
    const entries = listUnapplied(limit);
    const result: ApplyResult = { applied: 0, failed: [], by_op: {} };
    const db = getDb();

    for (const entry of entries) {
        try {
            db.transaction(() => {
                applyOne(entry);
                markApplied([entry.sync_id]);
            })();
            result.applied++;
            result.by_op[entry.op] = (result.by_op[entry.op] ?? 0) + 1;
        } catch (err) {
            result.failed.push({
                sync_id: entry.sync_id,
                op: entry.op,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return result;
}

function applyOne(entry: JournalEntry): void {
    switch (entry.op) {
        case 'concept_create':
            applyConceptCreate(entry);
            return;
        case 'trajectory':
            applyTrajectory(entry);
            return;
        case 'feedback':
            applyFeedback(entry);
            return;
        case 'truth_update':
            applyTruthUpdate(entry);
            return;
        case 'retire':
            applyRetire(entry);
            return;
        default: {
            /** TS exhaustiveness check + runtime guard against a future op. */
            const op: never = entry.op;
            throw new Error(`unknown journal op: ${String(op)}`);
        }
    }
}

/**
 * INSERT OR IGNORE on slug PK. mention_count starts at 1 (this is the
 * "first sighting" on this device); subsequent local upserts will bump it
 * via the existing ON CONFLICT path in `upsertConcept`. created_at and
 * updated_at use the entry's `created_at` so the local row carries the
 * originating device's timestamp.
 */
export function applyConceptCreate(entry: JournalEntry): void {
    const p = entry.payload as ConceptCreatePayload;
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO concepts
                 (slug, name, summary, compiled_truth, article,
                  created_at, updated_at, mention_count, scope_kind, scope_key)
             VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
            p.slug,
            p.name,
            p.summary,
            p.compiled_truth,
            entry.created_at,
            entry.created_at,
            entry.scope_kind,
            entry.scope_key,
        );
}

/**
 * Reconstruct the source row + replay chunks from the journal payload's
 * `metadata`. source_id is content-hashed by the originating device, so
 * INSERT OR IGNORE on the sources PK gives free idempotency. Chunks use
 * the same `buildTrajectoryChunks` helper as the local capture path so
 * the chunk shape on the destination device is byte-identical.
 *
 * Touches the scopes registry on `codebase` scope so `lumen scope list`
 * surfaces the trajectory's codebase even on devices that haven't checked
 * out the codebase yet.
 */
export function applyTrajectory(entry: JournalEntry): void {
    const p = entry.payload as TrajectoryPayload;
    const metadata = p.metadata as unknown as TrajectoryMetadata;
    const metadataJson = JSON.stringify(metadata);

    /**
     * insertSource doesn't OR IGNORE — re-applying would throw on PK conflict.
     * Explicit existence check + early return makes the path idempotent without
     * widening insertSource's contract for everyone else.
     */
    const exists = getDb().prepare('SELECT 1 AS found FROM sources WHERE id = ?').get(p.source_id);
    if (exists) return;

    const wordCount = metadata.steps.reduce(
        (sum, s) => sum + s.result_summary.split(/\s+/).filter(Boolean).length,
        0,
    );

    insertSource({
        id: p.source_id,
        title: metadata.task,
        url: null,
        content: metadataJson,
        content_hash: contentHash(metadataJson),
        source_type: 'trajectory',
        added_at: entry.created_at,
        compiled_at: null,
        word_count: wordCount,
        language: null,
        metadata: metadataJson,
        scope_kind: entry.scope_kind,
        scope_key: entry.scope_key,
    });

    if (entry.scope_kind === 'codebase') {
        upsertScope({ kind: entry.scope_kind, key: entry.scope_key });
    }

    insertChunks(buildTrajectoryChunks(p.source_id, metadata));
}

/**
 * Insert one feedback row, then recompute concept.score from the table.
 *
 * The unique partial index on `concept_feedback(sync_id) WHERE sync_id IS
 * NOT NULL` (v16 migration) makes the INSERT OR IGNORE idempotent — re-
 * applying the same entry collides on sync_id and is silently dropped.
 *
 * Score recomputation runs unconditionally because it's cheap and
 * deterministic (`SUM(delta)` over all feedback for the slug). If the
 * INSERT was ignored, the score is already correct from the prior apply,
 * so the recompute is a no-op write.
 *
 * Auto-retire fires inside `updateScore` when the new score drops below
 * the threshold AND the concept isn't already retired (idempotent).
 */
export function applyFeedback(entry: JournalEntry): void {
    const p = entry.payload as FeedbackPayload;
    const slug = p.concept_slug;

    getDb()
        .prepare(
            `INSERT OR IGNORE INTO concept_feedback
                 (concept_slug, delta, reason, session_id, device_id, created_at, sync_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            slug,
            p.delta,
            p.reason,
            p.session_id,
            entry.device_id,
            entry.created_at,
            entry.sync_id,
        );

    /** Recompute score; updateScore handles auto-retire idempotently. */
    const newScore = feedbackTotal(slug);
    updateScore(slug, newScore);
}

/**
 * Last-write-wins on `updated_at`. Returns which side won so callers (and
 * tests) can assert the resolution.
 *
 * Winner: `compiled_truth` and `summary` overwritten on `concepts`; loser
 * lands in `concept_truth_history` with `superseded_by = entry.sync_id`.
 *
 * Loser: incoming truth lands in `concept_truth_history` with
 * `superseded_by = NULL` (we don't have a sync_id for the local winner —
 * locally-originated truth_updates don't get sync_ids until they push).
 *
 * Idempotency:
 *   - "won" path: existence check on `superseded_by = entry.sync_id`
 *     before writing history
 *   - "lost" path: existence check on (slug, updated_at, device_id, truth)
 *     before writing history (this composite is unique enough at our scale)
 *
 * Throws when the concept doesn't exist locally — the entry stays
 * `applied_at = NULL` so the next `applyPending` call retries it once the
 * prerequisite `concept_create` has landed.
 */
export function applyTruthUpdate(entry: JournalEntry): { lww: 'won' | 'lost' } {
    const p = entry.payload as TruthUpdatePayload;
    const slug = p.concept_slug;
    const db = getDb();

    const existing = db
        .prepare('SELECT compiled_truth, updated_at FROM concepts WHERE slug = ?')
        .get(slug) as { compiled_truth: string | null; updated_at: string } | undefined;
    if (!existing) throw new Error(`truth_update: concept not found for slug "${slug}" — will retry`);

    /**
     * Idempotency: after a successful won-path apply, concepts.updated_at
     * equals p.updated_at, so the `>` comparison below would flip the next
     * call to the loss path and add a spurious history row. Detect "already
     * applied as winner" via the superseded_by trail and return early.
     */
    const alreadyWon = db
        .prepare('SELECT 1 AS found FROM concept_truth_history WHERE superseded_by = ?')
        .get(entry.sync_id);
    if (alreadyWon) return { lww: 'won' };

    if (p.updated_at > existing.updated_at) {
        db.prepare(
            `INSERT INTO concept_truth_history (slug, truth, updated_at, device_id, superseded_by)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(slug, existing.compiled_truth ?? '', existing.updated_at, 'local', entry.sync_id);
        db.prepare(
            'UPDATE concepts SET compiled_truth = ?, summary = ?, updated_at = ? WHERE slug = ?',
        ).run(p.new_truth, p.new_truth, p.updated_at, slug);
        return { lww: 'won' };
    }

    /** Incoming loses — record it for audit, leave concepts row alone. */
    const already = db
        .prepare(
            `SELECT 1 FROM concept_truth_history
             WHERE slug = ? AND updated_at = ? AND device_id = ? AND truth = ?`,
        )
        .get(slug, p.updated_at, entry.device_id, p.new_truth);
    if (!already) {
        db.prepare(
            `INSERT INTO concept_truth_history (slug, truth, updated_at, device_id, superseded_by)
             VALUES (?, ?, ?, ?, NULL)`,
        ).run(slug, p.new_truth, p.updated_at, entry.device_id);
    }
    return { lww: 'lost' };
}

/**
 * Set `retired_at` and `retire_reason` if not already retired. COALESCE
 * preserves the original retirement on re-apply (idempotent — first device
 * to retire wins). Uses `entry.created_at` as the retirement timestamp so
 * the canonical retired_at on every device matches the originator.
 */
export function applyRetire(entry: JournalEntry): void {
    const p = entry.payload as RetirePayload;
    const info = getDb()
        .prepare(
            `UPDATE concepts
             SET retired_at = COALESCE(retired_at, ?),
                 retire_reason = COALESCE(retire_reason, ?)
             WHERE slug = ?`,
        )
        .run(entry.created_at, p.reason, p.concept_slug);
    if (info.changes === 0) {
        throw new Error(`retire: concept not found for slug "${p.concept_slug}" — will retry`);
    }
}
