/**
 * Sync module types.
 *
 * The journal is the boundary between the local store and any future relay.
 * Every concept-touching mutation (trajectory capture, feedback, truth
 * update, retirement, concept creation) appends one row here. Tier 5b
 * encrypts these rows; Tier 5c pushes/pulls them; Tier 5e applies pulled
 * rows back to the local store.
 *
 * For Tier 5a only the local writes happen — `pushed_at`, `pulled_at`,
 * and `applied_at` stay null.
 */

import type { ScopeKind } from '../types/index.js';

/**
 * The five operation kinds the journal records. Each maps to one
 * concept-touching mutation in the public store API.
 *
 * Constraint: this set is mirrored in the v15 CHECK on sync_journal.op.
 * Adding a new value requires a schema migration to widen the CHECK.
 */
export type JournalOp = 'trajectory' | 'feedback' | 'truth_update' | 'retire' | 'concept_create';

/** Op-specific payload shapes. JSON-encoded into sync_journal.payload. */
export type TrajectoryPayload = {
    /** Source row id of the captured trajectory. */
    source_id: string;
    /** Full TrajectoryMetadata JSON, ready for re-insertion on a peer device. */
    metadata: Record<string, unknown>;
};

export type FeedbackPayload = {
    concept_slug: string;
    delta: -1 | 1;
    reason: string | null;
    session_id: string | null;
};

export type TruthUpdatePayload = {
    concept_slug: string;
    new_truth: string;
    /** ISO timestamp - tiebreaker for last-write-wins on a peer device. */
    updated_at: string;
};

export type RetirePayload = {
    concept_slug: string;
    reason: string;
};

export type ConceptCreatePayload = {
    slug: string;
    name: string;
    summary: string | null;
    compiled_truth: string | null;
};

/**
 * One row in `sync_journal`. The `payload` shape is determined by `op`;
 * callers should narrow via the discriminated `JournalOp` before reading.
 */
export type JournalEntry = {
    sync_id: string;
    op: JournalOp;
    entity_id: string;
    scope_kind: ScopeKind;
    scope_key: string;
    payload: Record<string, unknown>;
    device_id: string;
    created_at: string;
    pushed_at: string | null;
    pulled_at: string | null;
    applied_at: string | null;
};

/**
 * The singleton `sync_state` row. Lazily created on first journal write
 * with a random `device_id`. `user_hash`, `relay_url`, and key fingerprint
 * are populated by Tier 5c's `lumen sync init`. Until then the row exists
 * but the device is "unsynced" - journaling continues regardless.
 */
export type SyncState = {
    device_id: string;
    user_hash: string | null;
    relay_url: string | null;
    last_pull_cursor: string | null;
    last_push_cursor: string | null;
    encryption_key_fingerprint: string | null;
    enabled: 0 | 1;
    last_pull_at: string | null;
    last_push_at: string | null;
    last_error: string | null;
};
