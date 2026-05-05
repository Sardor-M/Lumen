/**
 * Push/pull orchestrator. Wires the journal (5a), the encryption envelope
 * (5b), the keyring, and the relay client into a single command-driven
 * sync cycle.
 *
 * Push:
 *   1. Load Kx from keyring; abort if missing.
 *   2. Load `sync_state` to get device_id, user_hash, relay_url.
 *   3. `listUnpushed(batchSize)` — oldest journal entries pending push.
 *   4. Encrypt each entry's payload-shaped row into an envelope.
 *   5. POST batch to relay.
 *   6. `markPushed` for accepted sync_ids; surface rejected ones in the result.
 *
 * Pull:
 *   1. Load Kx from keyring; abort if missing.
 *   2. Compute local scope tags (registry-backed).
 *   3. `getJournal` since last_pull_cursor (loop while next_cursor != null,
 *      capped by batchSize).
 *   4. Decrypt each envelope. AEAD failure: log + skip, don't abort batch.
 *   5. `insertPulled` (idempotent on sync_id).
 *   6. Advance `last_pull_cursor`.
 *
 * Sync:
 *   - push then pull, in that order, sharing a single circuit-breaker.
 *
 * Circuit-break:
 *   - Tracks consecutive failed sync cycles in-memory (process-local).
 *   - After CIRCUIT_BREAK_THRESHOLD cycles, sets `sync_state.last_error` and
 *     subsequent calls return early until `clearLastError()` is called via
 *     `lumen sync reset-error`.
 *   - On success the in-memory counter resets and `last_error` is cleared.
 */

import { listUnpushed, markPushed, insertPulled } from './journal.js';
import {
    getOrInitSyncState,
    setLastError,
    setLastPushAt,
    updateCursor,
    setRelayConfig,
} from './state.js';
import { getMasterKey } from './keyring.js';
import {
    encryptEnvelope,
    decryptEnvelope,
    deriveScopeRoutingTag,
    deriveUserHash,
    fingerprintMasterKey,
} from './crypto.js';
import {
    postJournal,
    getJournal,
    type FetchLike,
    type PushBatch,
    type PushEntry,
    type PullEntry,
} from './relay-client.js';
import { listScopes } from '../store/scopes.js';
import { applyPending, type ApplyOptions } from './apply.js';
import type { JournalEntry, JournalOp } from './types.js';
import type { ScopeKind } from '../types/index.js';

export type SyncResult = {
    pushed: number;
    pulled: number;
    /**
     * Tier 5e: number of pulled entries successfully applied to the local
     * store this cycle. Always 0 from `runPush`/`runPull` standalone — only
     * `runApply` and `runSync` (which calls apply after pull) advance it.
     */
    applied: number;
    /** Tier 5e: number of pulled entries whose per-op apply threw. They stay applied_at = NULL for retry. */
    apply_failed: number;
    rejected: number;
    errors: string[];
};

export type DriverOptions = {
    /** Max entries per push/pull batch. Default 200. */
    batchSize?: number;
    /** Injectable for tests. Defaults to global fetch. */
    fetchImpl?: FetchLike;
};

const DEFAULT_BATCH_SIZE = 200;
const CIRCUIT_BREAK_THRESHOLD = 5;

let consecutiveFailures = 0;

/** ─── Public driver entry points ─── */

export async function runPush(opts: DriverOptions = {}): Promise<SyncResult> {
    const result = emptyResult();
    const ctx = loadContext(result);
    if (!ctx) return result;

    try {
        await doPush(ctx, opts, result);
        onSuccess();
    } catch (err) {
        onFailure(err, result);
    }
    return result;
}

export async function runPull(opts: DriverOptions = {}): Promise<SyncResult> {
    const result = emptyResult();
    const ctx = loadContext(result);
    if (!ctx) return result;

    try {
        await doPull(ctx, opts, result);
        onSuccess();
    } catch (err) {
        onFailure(err, result);
    }
    return result;
}

export async function runSync(opts: DriverOptions = {}): Promise<SyncResult> {
    const result = emptyResult();
    const ctx = loadContext(result);
    if (!ctx) return result;

    try {
        await doPush(ctx, opts, result);
        await doPull(ctx, opts, result);
        /**
         * Apply runs after pull so freshly-pulled entries land in the local
         * store this cycle. Apply doesn't touch the network — failures here
         * (e.g. a feedback whose concept_create hasn't arrived yet) don't
         * trip the circuit-breaker; they're recorded in `apply_failed` and
         * the next runSync cycle retries them.
         */
        runApplyInPlace({ limit: opts.batchSize }, result);
        onSuccess();
    } catch (err) {
        onFailure(err, result);
    }
    return result;
}

/**
 * Drain the pending-apply backlog without touching the network. Useful when
 * a previous pull succeeded but apply failed (e.g. an out-of-order entry
 * waited on its concept_create), or for the standalone `lumen sync apply`
 * CLI subcommand.
 *
 * Skips the loadContext circuit-breaker preflight because apply is purely
 * local — it doesn't make sense for a network outage to gate local store
 * mutations on entries we already pulled successfully.
 */
export function runApply(opts: ApplyOptions = {}): SyncResult {
    const result = emptyResult();
    runApplyInPlace(opts, result);
    return result;
}

function runApplyInPlace(opts: ApplyOptions, result: SyncResult): void {
    const apply = applyPending(opts);
    /**
     * Additive semantics — matches the `errors.push` on the same path. The
     * function is only called once per `runSync` today, but a future caller
     * that wants a staged apply (e.g., apply twice with different limits)
     * shouldn't silently lose the first pass's counts.
     */
    result.applied += apply.applied;
    result.apply_failed += apply.failed.length;
    for (const f of apply.failed) {
        result.errors.push(`apply ${f.op} ${f.sync_id}: ${f.reason}`);
    }
}

/** Reset the circuit breaker after the user has confirmed the relay is reachable. */
export function clearLastError(): void {
    consecutiveFailures = 0;
    setLastError(null);
}

/** Test helper. Resets the in-memory consecutive-failures counter. */
export function resetCircuitBreakerForTests(): void {
    consecutiveFailures = 0;
}

/** ─── Context loading + preflight ─── */

type Context = {
    masterKey: Buffer;
    deviceId: string;
    userHash: string;
    relayUrl: string;
};

function loadContext(result: SyncResult): Context | null {
    const state = getOrInitSyncState();

    if (state.enabled !== 1) {
        result.errors.push('sync is disabled — run `lumen sync enable`');
        return null;
    }
    if (state.last_error) {
        result.errors.push(
            `circuit-breaker open (${state.last_error}) — run \`lumen sync reset-error\` to retry`,
        );
        return null;
    }
    if (!state.relay_url) {
        result.errors.push('no relay configured — run `lumen sync init --relay <url>`');
        return null;
    }

    const masterKey = getMasterKey();
    if (!masterKey) {
        result.errors.push('master key not in keyring — run `lumen sync init`');
        return null;
    }

    const userHash = state.user_hash ?? deriveUserHash(masterKey);
    if (!state.user_hash) {
        /** Older state row written before user_hash existed; backfill. */
        setRelayConfig({
            user_hash: userHash,
            encryption_key_fingerprint: fingerprintMasterKey(masterKey),
        });
    }

    return {
        masterKey,
        deviceId: state.device_id,
        userHash,
        relayUrl: state.relay_url,
    };
}

/** ─── Push pipeline ─── */

async function doPush(ctx: Context, opts: DriverOptions, result: SyncResult): Promise<void> {
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const unpushed = listUnpushed(batchSize);
    if (unpushed.length === 0) return;

    const batch: PushBatch = {
        device_id: ctx.deviceId,
        entries: unpushed.map((entry) => buildPushEntry(entry, ctx.masterKey)),
    };

    const response = await postJournal(ctx.relayUrl, ctx.userHash, batch, opts.fetchImpl);
    const rejectedSet = new Set(response.rejected.map((r) => r.sync_id));
    const accepted = unpushed.filter((e) => !rejectedSet.has(e.sync_id)).map((e) => e.sync_id);

    if (accepted.length > 0) {
        markPushed(accepted);
        /** Surface the push timestamp in `sync status`. */
        setLastPushAt();
    }

    result.pushed = accepted.length;
    result.rejected = response.rejected.length;
    for (const r of response.rejected) result.errors.push(`rejected ${r.sync_id}: ${r.reason}`);
}

function buildPushEntry(entry: JournalEntry, masterKey: Buffer): PushEntry {
    const plaintext = JSON.stringify({
        op: entry.op,
        entity_id: entry.entity_id,
        scope_kind: entry.scope_kind,
        scope_key: entry.scope_key,
        payload: entry.payload,
        device_id: entry.device_id,
        created_at: entry.created_at,
    });
    return {
        sync_id: entry.sync_id,
        envelope: encryptEnvelope(plaintext, masterKey),
        scope_routing_tag: deriveScopeRoutingTag(masterKey, {
            kind: entry.scope_kind,
            key: entry.scope_key,
        }),
    };
}

/** ─── Pull pipeline ─── */

async function doPull(ctx: Context, opts: DriverOptions, result: SyncResult): Promise<void> {
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const scopeTags = computeLocalScopeTags(ctx.masterKey);
    const state = getOrInitSyncState();

    let cursor = state.last_pull_cursor ?? undefined;
    let totalInserted = 0;
    /**
     * Bounds work per pull cycle. `totalInserted` only counts new rows, so
     * a relay that streams pages of duplicates would slip past the cap if
     * we used it as the loop guard. Track entries seen instead.
     */
    let totalProcessed = 0;
    /** Highest sync_id seen across all pages this cycle. */
    let highestSyncId: string | null = null;
    /** True iff the relay returned a page with entries and `next_cursor: null`. */
    let terminalPage = false;

    /** Loop until the relay has nothing more (or we hit batchSize cap). */
    while (totalProcessed < batchSize) {
        const remaining = batchSize - totalProcessed;
        const batch = await getJournal(
            ctx.relayUrl,
            ctx.userHash,
            { since: cursor, limit: remaining, scopeTags },
            opts.fetchImpl,
        );
        if (batch.entries.length === 0) break;

        for (const remote of batch.entries) {
            const inserted = applyPulledEntry(remote, ctx.masterKey, result);
            if (inserted) totalInserted++;
            totalProcessed++;
            if (highestSyncId === null || remote.sync_id > highestSyncId) {
                highestSyncId = remote.sync_id;
            }
        }

        if (!batch.next_cursor) {
            terminalPage = true;
            break;
        }
        /**
         * Cursor must move forward each page. If the relay returns the same
         * cursor twice, treat it as end-of-stream — better than spinning
         * forever on a misbehaving relay or a replayed page of duplicates.
         */
        if (batch.next_cursor === cursor) break;
        cursor = batch.next_cursor;
    }

    /**
     * Resolve the cursor to persist:
     *   - Terminal page (`next_cursor: null` with entries): use the highest
     *     sync_id we saw. sync_ids are sortable, so the last entry of the
     *     last page is the new high-water mark — and using the unchanged
     *     server-side cursor would cause the next cycle to re-fetch the
     *     same terminal page (insertPulled is idempotent, but wasteful).
     *   - Mid-stream pagination: use the latest server cursor. Server
     *     cursors are opaque tokens that may not be sync_ids, and the
     *     relay may not accept a sync_id as `since`.
     */
    const newCursor = terminalPage ? highestSyncId : cursor;
    if (newCursor && newCursor !== state.last_pull_cursor) {
        updateCursor({ last_pull_cursor: newCursor });
    }
    result.pulled = totalInserted;
}

type PulledPlaintext = {
    op: JournalOp;
    entity_id: string;
    scope_kind: ScopeKind;
    scope_key: string;
    payload: Record<string, unknown>;
    device_id: string;
    created_at: string;
};

function applyPulledEntry(remote: PullEntry, masterKey: Buffer, result: SyncResult): boolean {
    let plaintext: string;
    try {
        plaintext = decryptEnvelope(remote.envelope, masterKey);
    } catch (err) {
        result.errors.push(
            `decrypt failed for ${remote.sync_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
    }

    let parsed: PulledPlaintext;
    try {
        parsed = JSON.parse(plaintext) as PulledPlaintext;
    } catch (err) {
        result.errors.push(
            `JSON parse failed for ${remote.sync_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
    }

    return insertPulled({
        sync_id: remote.sync_id,
        op: parsed.op,
        entity_id: parsed.entity_id,
        scope_kind: parsed.scope_kind,
        scope_key: parsed.scope_key,
        payload: parsed.payload,
        device_id: parsed.device_id,
        created_at: parsed.created_at,
    });
}

/** ─── Local scope tags ─── */

/**
 * Compute the set of scope tags this device wants to subscribe to. Drawn
 * from the local `scopes` registry — every (kind, key) the resolver has
 * touched is included. `codebase` keys with the `local-` prefix are
 * filtered out: they're path-based fingerprints that have no meaning
 * across devices.
 *
 * The `personal:me` tag is always included so personal-scope writes from
 * any device land here.
 */
export function computeLocalScopeTags(masterKey: Buffer): string[] {
    const tags = new Set<string>();
    tags.add(deriveScopeRoutingTag(masterKey, { kind: 'personal', key: 'me' }));

    for (const scope of listScopes()) {
        if (scope.kind === 'codebase' && scope.key.startsWith('local-')) continue;
        tags.add(deriveScopeRoutingTag(masterKey, { kind: scope.kind, key: scope.key }));
    }
    return [...tags];
}

/** ─── Circuit-breaker ─── */

function onSuccess(): void {
    if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        setLastError(null);
    }
}

function onFailure(err: unknown, result: SyncResult): void {
    consecutiveFailures++;
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    if (consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
        setLastError(`${consecutiveFailures} consecutive failures: ${message}`);
    }
}

function emptyResult(): SyncResult {
    return { pushed: 0, pulled: 0, applied: 0, apply_failed: 0, rejected: 0, errors: [] };
}
