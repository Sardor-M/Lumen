/**
 * Sync state CRUD — the singleton `sync_state` row.
 *
 * Lazy-initialized on first read with a fresh random `device_id`. All other
 * fields stay null/0 until Tier 5c's `lumen sync init` populates them.
 * Journaling proceeds unconditionally regardless of whether the device is
 * "configured for sync" — the journal is the source of truth, configuration
 * is just relay routing metadata.
 */

import { randomBytes } from 'node:crypto';
import { getDb } from '../store/database.js';
import { getStmt } from '../store/prepared.js';
import type { SyncState } from './types.js';

type RawStateRow = {
    device_id: string;
    user_hash: string | null;
    relay_url: string | null;
    last_pull_cursor: string | null;
    last_push_cursor: string | null;
    encryption_key_fingerprint: string | null;
    enabled: number;
    last_pull_at: string | null;
    last_push_at: string | null;
    last_error: string | null;
};

function rowToState(row: RawStateRow): SyncState {
    return {
        device_id: row.device_id,
        user_hash: row.user_hash,
        relay_url: row.relay_url,
        last_pull_cursor: row.last_pull_cursor,
        last_push_cursor: row.last_push_cursor,
        encryption_key_fingerprint: row.encryption_key_fingerprint,
        enabled: row.enabled === 1 ? 1 : 0,
        last_pull_at: row.last_pull_at,
        last_push_at: row.last_push_at,
        last_error: row.last_error,
    };
}

/** Fresh device_id: 16 hex chars (~64 bits, more than enough for collision-free per-user). */
function generateDeviceId(): string {
    return randomBytes(8).toString('hex');
}

/**
 * Return the singleton sync_state row, creating it if absent.
 * Idempotent: repeated calls return the same `device_id`.
 */
export function getOrInitSyncState(): SyncState {
    const db = getDb();
    const existing = getStmt(db, 'SELECT * FROM sync_state WHERE id = 1').get() as
        | RawStateRow
        | undefined;
    if (existing) return rowToState(existing);

    const deviceId = generateDeviceId();
    db.prepare(
        `INSERT INTO sync_state (id, device_id, enabled) VALUES (1, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
    ).run(deviceId);

    /** Concurrent caller may have raced us; either way row 1 now exists. */
    const row = getStmt(db, 'SELECT * FROM sync_state WHERE id = 1').get() as RawStateRow;
    return rowToState(row);
}

export function setEnabled(enabled: boolean): void {
    /** Ensure the row exists before updating. */
    getOrInitSyncState();
    getDb()
        .prepare('UPDATE sync_state SET enabled = ? WHERE id = 1')
        .run(enabled ? 1 : 0);
}

export function setRelayConfig(input: {
    user_hash?: string | null;
    relay_url?: string | null;
    encryption_key_fingerprint?: string | null;
}): void {
    getOrInitSyncState();
    const db = getDb();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.user_hash !== undefined) {
        sets.push('user_hash = ?');
        params.push(input.user_hash);
    }
    if (input.relay_url !== undefined) {
        sets.push('relay_url = ?');
        params.push(input.relay_url);
    }
    if (input.encryption_key_fingerprint !== undefined) {
        sets.push('encryption_key_fingerprint = ?');
        params.push(input.encryption_key_fingerprint);
    }
    if (sets.length === 0) return;
    db.prepare(`UPDATE sync_state SET ${sets.join(', ')} WHERE id = 1`).run(...params);
}

export function updateCursor(input: {
    last_push_cursor?: string;
    last_pull_cursor?: string;
}): void {
    getOrInitSyncState();
    const db = getDb();
    if (input.last_push_cursor !== undefined) {
        db.prepare(`UPDATE sync_state SET last_push_cursor = ?, last_push_at = ? WHERE id = 1`).run(
            input.last_push_cursor,
            new Date().toISOString(),
        );
    }
    if (input.last_pull_cursor !== undefined) {
        db.prepare(`UPDATE sync_state SET last_pull_cursor = ?, last_pull_at = ? WHERE id = 1`).run(
            input.last_pull_cursor,
            new Date().toISOString(),
        );
    }
}

/**
 * Stamp `last_push_at = now` without touching the cursor. Push is per-entry
 * (each row's `pushed_at` is set by `markPushed`), so there's no meaningful
 * "push cursor" — but the status display reads `sync_state.last_push_at`,
 * which would otherwise stay null forever.
 */
export function setLastPushAt(): void {
    getOrInitSyncState();
    getDb()
        .prepare('UPDATE sync_state SET last_push_at = ? WHERE id = 1')
        .run(new Date().toISOString());
}

export function setLastError(error: string | null): void {
    getOrInitSyncState();
    getDb().prepare('UPDATE sync_state SET last_error = ? WHERE id = 1').run(error);
}
