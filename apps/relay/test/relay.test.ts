/**
 * Relay end-to-end tests: round-trip, dedupe, pagination, scope filter,
 * tombstone, validation. Rate-limit tests live in rate-limit.test.ts.
 *
 * Uses vitest-pool-workers' SELF.fetch to call the deployed Worker against
 * a real D1 in miniflare, so SQL-level behavior (PK conflict, ORDER BY,
 * scope filter) is exercised, not mocked.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
    OTHER_USER_HASH,
    SCOPE_A,
    SCOPE_B,
    USER_HASH,
    deleteEntry,
    get,
    makeEntry,
    makeEnvelope,
    makeSyncId,
    postBatch,
} from './helpers.js';

describe('GET /v1/health', () => {
    it('returns ok + version', async () => {
        const res = await SELF.fetch('https://relay.test/v1/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, version: '1' });
    });
});

describe('POST /v1/journal/:user_hash', () => {
    it('accepts a single entry and returns accepted count', async () => {
        const entry = makeEntry();
        const { status, body } = await postBatch(USER_HASH, [entry]);
        expect(status).toBe(200);
        expect(body.accepted).toBe(1);
        expect(body.rejected).toEqual([]);
    });

    it('rejects a duplicate sync_id with reason="duplicate"', async () => {
        const syncId = makeSyncId();
        const entry = makeEntry({ syncId });

        const first = await postBatch(USER_HASH, [entry]);
        expect(first.body.accepted).toBe(1);

        const second = await postBatch(USER_HASH, [entry]);
        expect(second.body.accepted).toBe(0);
        expect(second.body.rejected).toEqual([{ sync_id: syncId, reason: 'duplicate' }]);
    });

    it('rejects an entry with malformed envelope without aborting the batch', async () => {
        const good = makeEntry();
        const bad = { sync_id: makeSyncId(), envelope: { v: 2 }, scope_routing_tag: SCOPE_A };
        const { body } = await postBatch(USER_HASH, [good, bad as never]);
        expect(body.accepted).toBe(1);
        expect(body.rejected).toHaveLength(1);
        expect(body.rejected[0].reason).toBe('invalid_envelope');
    });

    it('rejects an empty body as 400 (no device_id)', async () => {
        const res = await SELF.fetch(`https://relay.test/v1/journal/${USER_HASH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('rejects a malformed user_hash as 400', async () => {
        const res = await SELF.fetch(`https://relay.test/v1/journal/NOT_HEX`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_id: 'd', entries: [] }),
        });
        expect(res.status).toBe(400);
    });

    it('returns 200 with accepted=0 for an empty entries array', async () => {
        const { status, body } = await postBatch(USER_HASH, []);
        expect(status).toBe(200);
        expect(body).toEqual({ accepted: 0, rejected: [] });
    });
});

describe('GET /v1/journal/:user_hash', () => {
    it('returns previously pushed entries with bytes preserved exactly', async () => {
        const envelope = makeEnvelope('round-trip');
        const entry = { sync_id: makeSyncId(), envelope, scope_routing_tag: SCOPE_A };
        await postBatch(USER_HASH, [entry]);

        const { status, body } = await get(USER_HASH);
        expect(status).toBe(200);
        const found = body.entries.find((e) => e.sync_id === entry.sync_id);
        expect(found).toBeDefined();
        expect(found?.envelope).toEqual(envelope);
        expect(found?.scope_routing_tag).toBe(SCOPE_A);
        expect(typeof found?.received_at).toBe('string');
    });

    it('paginates: limit caps results, next_cursor advances', async () => {
        const entries = Array.from({ length: 5 }, () => makeEntry({ scopeTag: SCOPE_A }));
        await postBatch(USER_HASH, entries);

        const page1 = await get(USER_HASH, { limit: 2 });
        expect(page1.body.entries).toHaveLength(2);
        expect(page1.body.next_cursor).toBe(page1.body.entries[1].sync_id);

        const page2 = await get(USER_HASH, {
            limit: 2,
            since: page1.body.next_cursor ?? undefined,
        });
        expect(page2.body.entries).toHaveLength(2);
        expect(page2.body.entries[0].sync_id > (page1.body.next_cursor ?? '')).toBe(true);
        expect(page2.body.next_cursor).toBe(page2.body.entries[1].sync_id);

        const page3 = await get(USER_HASH, {
            limit: 2,
            since: page2.body.next_cursor ?? undefined,
        });
        expect(page3.body.entries.length).toBeLessThan(2);
        expect(page3.body.next_cursor).toBeNull();
    });

    it('orders entries by sync_id ascending', async () => {
        const ids = [makeSyncId(100), makeSyncId(50), makeSyncId(75)];
        await postBatch(
            USER_HASH,
            ids.map((sid) => makeEntry({ syncId: sid })),
        );

        const { body } = await get(USER_HASH);
        const returned = body.entries.map((e) => e.sync_id);
        const sorted = [...returned].sort();
        expect(returned).toEqual(sorted);
    });

    it('filters by scope_tag when ?scope= is present', async () => {
        const a = makeEntry({ scopeTag: SCOPE_A });
        const b = makeEntry({ scopeTag: SCOPE_B });
        await postBatch(USER_HASH, [a, b]);

        const { body } = await get(USER_HASH, { scopeTags: [SCOPE_A] });
        const ids = body.entries.map((e) => e.sync_id);
        expect(ids).toContain(a.sync_id);
        expect(ids).not.toContain(b.sync_id);
    });

    it('accepts multiple ?scope= params (union)', async () => {
        const a = makeEntry({ scopeTag: SCOPE_A });
        const b = makeEntry({ scopeTag: SCOPE_B });
        await postBatch(USER_HASH, [a, b]);

        const { body } = await get(USER_HASH, { scopeTags: [SCOPE_A, SCOPE_B] });
        const ids = body.entries.map((e) => e.sync_id);
        expect(ids).toContain(a.sync_id);
        expect(ids).toContain(b.sync_id);
    });

    it('returns 0 entries for a user_hash with nothing pushed', async () => {
        const { body } = await get(OTHER_USER_HASH);
        expect(body.entries).toEqual([]);
        expect(body.next_cursor).toBeNull();
    });

    it('does not leak entries across user_hash boundaries', async () => {
        const entry = makeEntry();
        await postBatch(USER_HASH, [entry]);

        const { body } = await get(OTHER_USER_HASH);
        expect(body.entries.find((e) => e.sync_id === entry.sync_id)).toBeUndefined();
    });

    it('rejects malformed since= as 400', async () => {
        const res = await SELF.fetch(
            `https://relay.test/v1/journal/${USER_HASH}?since=not-a-sync-id`,
        );
        expect(res.status).toBe(400);
    });
});

describe('DELETE /v1/journal/:user_hash/:sync_id', () => {
    it('returns 204 and removes the row from subsequent GETs', async () => {
        const entry = makeEntry();
        await postBatch(USER_HASH, [entry]);

        const before = await get(USER_HASH);
        expect(before.body.entries.find((e) => e.sync_id === entry.sync_id)).toBeDefined();

        const { status } = await deleteEntry(USER_HASH, entry.sync_id);
        expect(status).toBe(204);

        const after = await get(USER_HASH);
        expect(after.body.entries.find((e) => e.sync_id === entry.sync_id)).toBeUndefined();
    });

    it('is idempotent: second DELETE on a missing row still returns 204', async () => {
        const entry = makeEntry();
        await postBatch(USER_HASH, [entry]);
        await deleteEntry(USER_HASH, entry.sync_id);
        const second = await deleteEntry(USER_HASH, entry.sync_id);
        expect(second.status).toBe(204);
    });
});

describe('catch-all', () => {
    it('returns 400 problem+json for an unknown route', async () => {
        const res = await SELF.fetch('https://relay.test/no-such-route');
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
    });
});
