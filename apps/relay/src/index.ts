/**
 * Lumen relay — reference Cloudflare Worker implementation.
 *
 * Zero-knowledge journal store: accepts opaque encrypted envelopes from
 * clients, indexes them by `user_hash` (a one-way derivative of the client's
 * master key), serves them back via cursor-paginated GET. The Worker cannot
 * decrypt anything; envelopes are sealed with X25519 + XChaCha20-Poly1305
 * on the device before they ever leave.
 *
 * Wire format matches `apps/cli/src/sync/relay-client.ts`. See SYNC-PROTOCOL.md
 * for the full design memo and TIER-5D-RELAY-WORKER.md for this tier's scope.
 *
 * Endpoints:
 *   POST   /v1/journal/:user_hash             — push a batch of encrypted entries
 *   GET    /v1/journal/:user_hash             — pull since cursor, scope-filtered
 *   DELETE /v1/journal/:user_hash/:sync_id    — tombstone (also drops the blob)
 *   GET    /v1/health                         — liveness check
 */

import { Hono } from 'hono';
import { checkAndIncrement } from './rate-limit.js';
import type { Bindings, EncryptionEnvelope, PullEntry, PushBatch, PushRejection } from './types.js';
import {
    badRequest,
    isValidPushEntry,
    isValidScopeTag,
    isValidSyncId,
    isValidUserHash,
    payloadTooLarge,
    rateLimited,
    readNumberVar,
    readRateLimit,
} from './validation.js';

const DEFAULT_MAX_ENVELOPE_BYTES = 262_144;
const DEFAULT_MAX_BATCH_ENTRIES = 100;
const DEFAULT_MAX_PULL_LIMIT = 500;
const DEFAULT_PULL_LIMIT = 100;
/**
 * Default rate limits per user_hash. Match SYNC-PROTOCOL.md §5.4.
 * Override via the RATE_LIMIT_* env vars in wrangler.toml — set any to "0"
 * to disable just that limit.
 */
const DEFAULT_RL_PUSH_REQ_PER_MIN = 50;
const DEFAULT_RL_PULL_REQ_PER_MIN = 100;
const DEFAULT_RL_PUSH_ENTRIES_PER_HOUR = 1000;
const DEFAULT_RL_BYTES_PER_DAY = 100 * 1024 * 1024;

const app = new Hono<{ Bindings: Bindings }>();

app.get('/v1/health', (c) => c.json({ ok: true, version: '1' }));

/** Push: accept a batch of encrypted entries, return per-entry accept/reject. */
app.post('/v1/journal/:user_hash', async (c) => {
    const userHash = c.req.param('user_hash');
    if (!isValidUserHash(userHash)) {
        return badRequest(c, 'user_hash must be 16 lowercase hex characters');
    }

    const maxEnvelopeBytes = readNumberVar(c.env.MAX_ENVELOPE_BYTES, DEFAULT_MAX_ENVELOPE_BYTES);
    const maxBatchEntries = readNumberVar(c.env.MAX_BATCH_ENTRIES, DEFAULT_MAX_BATCH_ENTRIES);

    /** Per-request rate limit, before any work — cheapest gate. */
    const reqLimit = readRateLimit(
        c.env.RATE_LIMIT_PUSH_REQUESTS_PER_MINUTE,
        DEFAULT_RL_PUSH_REQ_PER_MIN,
    );
    const reqRl = await checkAndIncrement(c.env.RATE_LIMIT, userHash, 'push_req', 1, reqLimit, 60);
    if (!reqRl.ok) return rateLimited(c, reqRl.kind, reqRl.retry_after);

    /**
     * Daily byte budget — best-effort via Content-Length. The header isn't
     * authoritative (clients can lie), but the per-envelope and per-batch
     * caps below bound actual ingest, so this is just a coarse guard against
     * an aggressive sender.
     */
    const contentLength = Number.parseInt(c.req.header('content-length') ?? '0', 10) || 0;
    if (contentLength > 0) {
        const bytesLimit = readRateLimit(c.env.RATE_LIMIT_BYTES_PER_DAY, DEFAULT_RL_BYTES_PER_DAY);
        const bytesRl = await checkAndIncrement(
            c.env.RATE_LIMIT,
            userHash,
            'bytes',
            contentLength,
            bytesLimit,
            86_400,
        );
        if (!bytesRl.ok) return rateLimited(c, bytesRl.kind, bytesRl.retry_after);
    }

    let batch: PushBatch;
    try {
        batch = (await c.req.json()) as PushBatch;
    } catch {
        return badRequest(c, 'request body must be valid JSON');
    }
    if (!batch || typeof batch !== 'object') {
        return badRequest(c, 'request body must be a JSON object');
    }
    if (typeof batch.device_id !== 'string' || batch.device_id.length === 0) {
        return badRequest(c, 'device_id is required');
    }
    if (!Array.isArray(batch.entries)) {
        return badRequest(c, 'entries must be an array');
    }
    if (batch.entries.length === 0) {
        return c.json({ accepted: 0, rejected: [] });
    }
    if (batch.entries.length > maxBatchEntries) {
        return payloadTooLarge(c, `entries exceeds max batch size (${maxBatchEntries})`);
    }

    /**
     * Per-hour entry budget — count entries (not requests). A misbehaving
     * client could spam tiny batches under push_req but still flood the
     * journal; this limit is the actual write-rate ceiling.
     */
    const entriesLimit = readRateLimit(
        c.env.RATE_LIMIT_PUSH_ENTRIES_PER_HOUR,
        DEFAULT_RL_PUSH_ENTRIES_PER_HOUR,
    );
    const entriesRl = await checkAndIncrement(
        c.env.RATE_LIMIT,
        userHash,
        'push_entries',
        batch.entries.length,
        entriesLimit,
        3600,
    );
    if (!entriesRl.ok) return rateLimited(c, entriesRl.kind, entriesRl.retry_after);

    const rejected: PushRejection[] = [];
    const insertable: Array<{ sync_id: string; envelope: Uint8Array; scope_tag: string }> = [];

    for (const raw of batch.entries) {
        if (!isValidPushEntry(raw)) {
            const sid =
                raw &&
                typeof raw === 'object' &&
                typeof (raw as { sync_id?: unknown }).sync_id === 'string'
                    ? (raw as { sync_id: string }).sync_id
                    : '';
            rejected.push({ sync_id: sid, reason: classifyEntryRejection(raw) });
            continue;
        }
        const envelopeBytes = encodeEnvelope(raw.envelope);
        if (envelopeBytes.byteLength > maxEnvelopeBytes) {
            rejected.push({ sync_id: raw.sync_id, reason: 'oversize' });
            continue;
        }
        insertable.push({
            sync_id: raw.sync_id,
            envelope: envelopeBytes,
            scope_tag: raw.scope_routing_tag,
        });
    }

    let accepted = 0;
    if (insertable.length > 0) {
        const receivedAt = new Date().toISOString();
        const stmt = c.env.DB.prepare(
            'INSERT OR IGNORE INTO journal_blobs (user_hash, sync_id, envelope, scope_tag, received_at) VALUES (?, ?, ?, ?, ?)',
        );
        const results = await c.env.DB.batch(
            insertable.map((row) =>
                stmt.bind(userHash, row.sync_id, row.envelope, row.scope_tag, receivedAt),
            ),
        );
        for (let i = 0; i < results.length; i++) {
            if ((results[i].meta.changes ?? 0) > 0) {
                accepted++;
            } else {
                rejected.push({ sync_id: insertable[i].sync_id, reason: 'duplicate' });
            }
        }
    }

    return c.json({ accepted, rejected });
});

/**
 * Pull: paginated GET ordered by sync_id (UUIDv7-shaped, lexicographically
 * sortable). The client's sync-driver uses sync_id as its high-water mark
 * on terminal pages, so cursor === sync_id is the simplest scheme.
 *
 *   ?since=<sync_id>     — exclusive lower bound; default = beginning
 *   ?limit=<int>         — clamped to MAX_PULL_LIMIT, default DEFAULT_PULL_LIMIT
 *   ?scope=<hex>&...     — repeated query param; if any present, filter to those scope tags
 */
app.get('/v1/journal/:user_hash', async (c) => {
    const userHash = c.req.param('user_hash');
    if (!isValidUserHash(userHash)) {
        return badRequest(c, 'user_hash must be 16 lowercase hex characters');
    }

    const pullReqLimit = readRateLimit(
        c.env.RATE_LIMIT_PULL_REQUESTS_PER_MINUTE,
        DEFAULT_RL_PULL_REQ_PER_MIN,
    );
    const pullRl = await checkAndIncrement(
        c.env.RATE_LIMIT,
        userHash,
        'pull_req',
        1,
        pullReqLimit,
        60,
    );
    if (!pullRl.ok) return rateLimited(c, pullRl.kind, pullRl.retry_after);

    const maxPullLimit = readNumberVar(c.env.MAX_PULL_LIMIT, DEFAULT_MAX_PULL_LIMIT);
    const defaultPullLimit = readNumberVar(c.env.DEFAULT_PULL_LIMIT, DEFAULT_PULL_LIMIT);

    const since = c.req.query('since');
    if (since !== undefined && !isValidSyncId(since)) {
        return badRequest(c, 'since must be a valid sync_id');
    }
    const limitRaw = c.req.query('limit');
    const limit = clampLimit(limitRaw, defaultPullLimit, maxPullLimit);
    if (limit === null) {
        return badRequest(c, 'limit must be a positive integer');
    }

    const scopeTags = c.req.queries('scope') ?? [];
    for (const tag of scopeTags) {
        if (!isValidScopeTag(tag)) {
            return badRequest(c, 'scope tags must be 16 lowercase hex characters');
        }
    }

    const { sql, params } = buildPullQuery({ userHash, since, scopeTags, limit });
    const { results } = await c.env.DB.prepare(sql)
        .bind(...params)
        .all();

    const entries: PullEntry[] = results.map((row) => {
        const r = row as Record<string, unknown>;
        return {
            sync_id: String(r.sync_id),
            envelope: decodeEnvelope(r.envelope),
            scope_routing_tag: String(r.scope_tag),
            received_at: String(r.received_at),
        };
    });

    /**
     * If we returned fewer rows than requested, there's no next page —
     * tell the client to stop with `next_cursor: null`. Otherwise hand
     * back the last sync_id so the next request continues from there.
     */
    const next_cursor = entries.length < limit ? null : entries[entries.length - 1].sync_id;

    return c.json({ entries, next_cursor });
});

/**
 * Delete: insert a tombstone marker AND drop the blob, atomically. Tier 6
 * will surface tombstones to other devices so they can drop their local
 * copies; for 5d the tombstone is just a paper trail.
 */
app.delete('/v1/journal/:user_hash/:sync_id', async (c) => {
    const userHash = c.req.param('user_hash');
    const syncId = c.req.param('sync_id');
    if (!isValidUserHash(userHash)) {
        return badRequest(c, 'user_hash must be 16 lowercase hex characters');
    }
    if (!isValidSyncId(syncId)) {
        return badRequest(c, 'sync_id must be a valid sync_id');
    }

    const deletedAt = new Date().toISOString();
    await c.env.DB.batch([
        c.env.DB.prepare(
            'INSERT OR IGNORE INTO tombstones (user_hash, sync_id, deleted_at) VALUES (?, ?, ?)',
        ).bind(userHash, syncId, deletedAt),
        c.env.DB.prepare('DELETE FROM journal_blobs WHERE user_hash = ? AND sync_id = ?').bind(
            userHash,
            syncId,
        ),
    ]);

    return c.body(null, 204);
});

/** Catch-all 404 with problem+json so misrouted requests show the problem. */
app.notFound((c) => badRequest(c, `no route for ${c.req.method} ${new URL(c.req.url).pathname}`));

export default app;

/** ─── Helpers ─── */

function encodeEnvelope(envelope: EncryptionEnvelope): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(envelope));
}

function decodeEnvelope(blob: unknown): EncryptionEnvelope {
    const bytes =
        blob instanceof Uint8Array
            ? blob
            : blob instanceof ArrayBuffer
              ? new Uint8Array(blob)
              : new Uint8Array(0);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as EncryptionEnvelope;
}

/** Diagnose why a malformed PushEntry was rejected (best-effort). */
function classifyEntryRejection(raw: unknown): PushRejection['reason'] {
    if (!raw || typeof raw !== 'object') return 'invalid_envelope';
    const o = raw as Record<string, unknown>;
    if (typeof o.sync_id !== 'string' || !isValidSyncId(o.sync_id)) return 'invalid_sync_id';
    if (typeof o.scope_routing_tag !== 'string' || !isValidScopeTag(o.scope_routing_tag)) {
        return 'invalid_scope_tag';
    }
    return 'invalid_envelope';
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number | null {
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, max);
}

function buildPullQuery(opts: {
    userHash: string;
    since: string | undefined;
    scopeTags: string[];
    limit: number;
}): { sql: string; params: unknown[] } {
    const where: string[] = ['user_hash = ?'];
    const params: unknown[] = [opts.userHash];
    if (opts.since) {
        where.push('sync_id > ?');
        params.push(opts.since);
    }
    if (opts.scopeTags.length > 0) {
        const placeholders = opts.scopeTags.map(() => '?').join(', ');
        where.push(`scope_tag IN (${placeholders})`);
        params.push(...opts.scopeTags);
    }
    const sql = `SELECT sync_id, envelope, scope_tag, received_at FROM journal_blobs WHERE ${where.join(
        ' AND ',
    )} ORDER BY sync_id ASC LIMIT ?`;
    params.push(opts.limit);
    return { sql, params };
}
