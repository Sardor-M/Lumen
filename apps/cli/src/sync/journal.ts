/**
 * Sync journal CRUD — append-only log of every concept-touching mutation.
 *
 * The journal is the boundary between the local store and any future relay.
 * Every public mutator that writes to `concepts`, `concept_feedback`,
 * `concept_aliases`, or `sources` (when `source_type='trajectory'`) calls
 * `appendJournal()` inside the same transaction so the journal write is
 * atomic with the entity write.
 *
 * `sync_id` is a UUIDv7-shape string: `<unix-ms-hex>-<random-hex>`. Sortable
 * in insertion order (so cursor pagination on the relay works without a
 * separate index) and effectively unique across devices because the random
 * suffix is 80 bits.
 */

import { randomBytes } from 'node:crypto';
import { getDb } from '../store/database.js';
import { getStmt } from '../store/prepared.js';
import { getOrInitSyncState } from './state.js';
import type { ScopeKind } from '../types/index.js';
import type { JournalEntry, JournalOp } from './types.js';

type RawJournalRow = {
    sync_id: string;
    op: string;
    entity_id: string;
    scope_kind: string;
    scope_key: string;
    payload: string;
    device_id: string;
    created_at: string;
    pushed_at: string | null;
    pulled_at: string | null;
    applied_at: string | null;
};

function rowToEntry(row: RawJournalRow): JournalEntry {
    return {
        sync_id: row.sync_id,
        op: row.op as JournalOp,
        entity_id: row.entity_id,
        scope_kind: row.scope_kind as ScopeKind,
        scope_key: row.scope_key,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        device_id: row.device_id,
        created_at: row.created_at,
        pushed_at: row.pushed_at,
        pulled_at: row.pulled_at,
        applied_at: row.applied_at,
    };
}

/**
 * Per-process monotonic counter that guarantees within-millisecond sortability.
 * Without it, two `appendJournal` calls in the same ms share a time prefix and
 * the random suffix tiebreaks unpredictably - which breaks cursor pagination
 * and the tests that assert insertion order.
 */
let lastIdMs = 0;
let intraMsCounter = 0;

/**
 * Generate a sortable sync_id. Format: `<12 hex unix-ms>-<4 hex counter><16 hex random>`.
 *
 * Total: 32 hex chars after the `-`, comparable to UUIDv7. Sortable by
 * insertion order even within the same millisecond (counter dominates the
 * suffix's first 4 chars). Random suffix gives ~64 bits of cross-process
 * uniqueness, more than enough at our scale.
 */
function generateSyncId(): string {
    const now = Date.now();
    if (now === lastIdMs) {
        intraMsCounter++;
    } else {
        lastIdMs = now;
        intraMsCounter = 0;
    }
    const ms = now.toString(16).padStart(12, '0');
    const ctr = intraMsCounter.toString(16).padStart(4, '0');
    const rand = randomBytes(8).toString('hex');
    return `${ms}-${ctr}${rand}`;
}

/**
 * Append one entry to the journal. Lazy-initializes `sync_state` on first
 * call so the device_id is ready. Returns the new sync_id so callers can
 * correlate (e.g., capture_trajectory returns it for testability).
 */
export function appendJournal(input: {
    op: JournalOp;
    entity_id: string;
    scope_kind: ScopeKind;
    scope_key: string;
    payload: Record<string, unknown>;
}): string {
    const state = getOrInitSyncState();
    const sync_id = generateSyncId();
    const created_at = new Date().toISOString();

    getStmt(
        getDb(),
        `INSERT INTO sync_journal (
             sync_id, op, entity_id, scope_kind, scope_key, payload, device_id, created_at
         )
         VALUES (@sync_id, @op, @entity_id, @scope_kind, @scope_key, @payload, @device_id, @created_at)`,
    ).run({
        sync_id,
        op: input.op,
        entity_id: input.entity_id,
        scope_kind: input.scope_kind,
        scope_key: input.scope_key,
        payload: JSON.stringify(input.payload),
        device_id: state.device_id,
        created_at,
    });

    return sync_id;
}

/** Entries that haven't been pushed to the relay yet, oldest-first. */
export function listUnpushed(limit?: number): JournalEntry[] {
    const sql = limit
        ? `SELECT * FROM sync_journal WHERE pushed_at IS NULL ORDER BY sync_id ASC LIMIT ?`
        : `SELECT * FROM sync_journal WHERE pushed_at IS NULL ORDER BY sync_id ASC`;
    const rows = (
        limit ? getStmt(getDb(), sql).all(limit) : getStmt(getDb(), sql).all()
    ) as RawJournalRow[];
    return rows.map(rowToEntry);
}

/**
 * Entries pulled from the relay that haven't been applied locally yet.
 * Filter is `pulled_at IS NOT NULL AND applied_at IS NULL` so only remote
 * entries are returned - locally-originated entries don't need apply.
 */
export function listUnapplied(limit?: number): JournalEntry[] {
    const sql = limit
        ? `SELECT * FROM sync_journal WHERE pulled_at IS NOT NULL AND applied_at IS NULL ORDER BY sync_id ASC LIMIT ?`
        : `SELECT * FROM sync_journal WHERE pulled_at IS NOT NULL AND applied_at IS NULL ORDER BY sync_id ASC`;
    const rows = (
        limit ? getStmt(getDb(), sql).all(limit) : getStmt(getDb(), sql).all()
    ) as RawJournalRow[];
    return rows.map(rowToEntry);
}

/**
 * Insert a journal entry pulled from the relay. Idempotent on `sync_id` —
 * if the entry already exists locally (we wrote it ourselves, or already
 * pulled it on a prior cycle), the row is left untouched and the function
 * returns `false`. Returns `true` when a new row was inserted.
 *
 * Sets `pulled_at = now`; leaves `pushed_at`, `applied_at` null. Tier 5e's
 * apply pass walks `pulled_at IS NOT NULL AND applied_at IS NULL` to drive
 * remote→local mutations.
 */
export function insertPulled(input: {
    sync_id: string;
    op: JournalOp;
    entity_id: string;
    scope_kind: ScopeKind;
    scope_key: string;
    payload: Record<string, unknown>;
    device_id: string;
    created_at: string;
}): boolean {
    const pulled_at = new Date().toISOString();
    const result = getDb()
        .prepare(
            `INSERT INTO sync_journal (
                 sync_id, op, entity_id, scope_kind, scope_key, payload,
                 device_id, created_at, pulled_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sync_id) DO NOTHING`,
        )
        .run(
            input.sync_id,
            input.op,
            input.entity_id,
            input.scope_kind,
            input.scope_key,
            JSON.stringify(input.payload),
            input.device_id,
            input.created_at,
            pulled_at,
        );
    return result.changes > 0;
}

/** Bulk-mark entries as pushed. Idempotent: re-marking already-pushed entries is a no-op timestamp update. */
export function markPushed(syncIds: string[]): void {
    if (syncIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = syncIds.map(() => '?').join(', ');
    getDb()
        .prepare(`UPDATE sync_journal SET pushed_at = ? WHERE sync_id IN (${placeholders})`)
        .run(now, ...syncIds);
}

/** Bulk-mark entries as applied. Tier 5e calls this after running per-op apply functions. */
export function markApplied(syncIds: string[]): void {
    if (syncIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = syncIds.map(() => '?').join(', ');
    getDb()
        .prepare(`UPDATE sync_journal SET applied_at = ? WHERE sync_id IN (${placeholders})`)
        .run(now, ...syncIds);
}

/** Total journal entries. Useful for `lumen sync status`. */
export function countJournal(): number {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM sync_journal').get() as { c: number };
    return row.c;
}

/** Count entries pending push - drives the "journal lag" display. */
export function countUnpushed(): number {
    const row = getDb()
        .prepare('SELECT COUNT(*) as c FROM sync_journal WHERE pushed_at IS NULL')
        .get() as { c: number };
    return row.c;
}
