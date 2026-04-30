import { describe, it, expect, beforeAll, afterAll } from 'vitest';

beforeAll(() => {
    process.env.LUMEN_RELAY_NO_BACKOFF = '1';
});
afterAll(() => {
    delete process.env.LUMEN_RELAY_NO_BACKOFF;
});
import { postJournal, getJournal, deleteJournal, isRelayError } from '../src/sync/relay-client.js';
import type { FetchLike, PushBatch } from '../src/sync/relay-client.js';
import type { EncryptionEnvelope } from '../src/sync/crypto.js';

function fakeEnvelope(): EncryptionEnvelope {
    return { v: 1, e: 'ZQ==', n: 'bg==', c: 'Yw==' };
}

function pushBatch(): PushBatch {
    return {
        device_id: 'dev1',
        entries: [{ sync_id: 's1', envelope: fakeEnvelope(), scope_routing_tag: 't1' }],
    };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

/** ─── postJournal ─── */

describe('postJournal', () => {
    it('POSTs to /v1/journal/{userHash} with the batch as JSON body', async () => {
        const captured: { url: string; init?: RequestInit } = { url: '' };
        const fetchImpl: FetchLike = async (url, init) => {
            captured.url = url;
            captured.init = init;
            return jsonResponse({ accepted: 1, rejected: [] });
        };
        await postJournal('https://relay.example.com', 'abcd1234', pushBatch(), fetchImpl);
        expect(captured.url).toBe('https://relay.example.com/v1/journal/abcd1234');
        expect(captured.init?.method).toBe('POST');
        const body = JSON.parse(String(captured.init?.body));
        expect(body.device_id).toBe('dev1');
        expect(body.entries[0].sync_id).toBe('s1');
    });

    it('returns accepted count and rejected list from the response', async () => {
        const fetchImpl: FetchLike = async () =>
            jsonResponse({ accepted: 2, rejected: [{ sync_id: 's3', reason: 'bad envelope' }] });
        const result = await postJournal('https://r/', 'u', pushBatch(), fetchImpl);
        expect(result.accepted).toBe(2);
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].sync_id).toBe('s3');
    });

    it('throws RelayError on 4xx (non-429) without retrying', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls++;
            return new Response('bad request', { status: 400 });
        };
        await expect(postJournal('https://r/', 'u', pushBatch(), fetchImpl)).rejects.toMatchObject({
            name: 'RelayError',
            status: 400,
        });
        expect(calls).toBe(1);
    });

    it('trims trailing slash from relayUrl', async () => {
        const captured: { url: string } = { url: '' };
        const fetchImpl: FetchLike = async (url) => {
            captured.url = url;
            return jsonResponse({ accepted: 0, rejected: [] });
        };
        await postJournal('https://relay.example.com/', 'abc', pushBatch(), fetchImpl);
        expect(captured.url).toBe('https://relay.example.com/v1/journal/abc');
    });

    it('encodes special characters in userHash', async () => {
        const captured: { url: string } = { url: '' };
        const fetchImpl: FetchLike = async (url) => {
            captured.url = url;
            return jsonResponse({ accepted: 0, rejected: [] });
        };
        await postJournal('https://r', 'a/b c', pushBatch(), fetchImpl);
        expect(captured.url).toBe('https://r/v1/journal/a%2Fb%20c');
    });
});

/** ─── getJournal ─── */

describe('getJournal', () => {
    it('GETs /v1/journal/{userHash} with no query when opts is empty', async () => {
        const captured: { url: string; method?: string } = { url: '' };
        const fetchImpl: FetchLike = async (url, init) => {
            captured.url = url;
            captured.method = init?.method;
            return jsonResponse({ entries: [], next_cursor: null });
        };
        await getJournal('https://r', 'u', {}, fetchImpl);
        expect(captured.url).toBe('https://r/v1/journal/u');
        expect(captured.method).toBe('GET');
    });

    it('appends since/limit/scope query params', async () => {
        const captured: { url: string } = { url: '' };
        const fetchImpl: FetchLike = async (url) => {
            captured.url = url;
            return jsonResponse({ entries: [], next_cursor: null });
        };
        await getJournal(
            'https://r',
            'u',
            { since: 'cur1', limit: 50, scopeTags: ['t1', 't2'] },
            fetchImpl,
        );
        const u = new URL(captured.url);
        expect(u.searchParams.get('since')).toBe('cur1');
        expect(u.searchParams.get('limit')).toBe('50');
        expect(u.searchParams.getAll('scope')).toEqual(['t1', 't2']);
    });

    it('parses entries and next_cursor from response', async () => {
        const fetchImpl: FetchLike = async () =>
            jsonResponse({
                entries: [
                    {
                        sync_id: 's1',
                        envelope: fakeEnvelope(),
                        scope_routing_tag: 't',
                        received_at: '2026-04-30',
                    },
                ],
                next_cursor: 'cur2',
            });
        const batch = await getJournal('https://r', 'u', {}, fetchImpl);
        expect(batch.entries).toHaveLength(1);
        expect(batch.entries[0].sync_id).toBe('s1');
        expect(batch.next_cursor).toBe('cur2');
    });

    it('coerces missing fields to safe defaults', async () => {
        const fetchImpl: FetchLike = async () => jsonResponse({});
        const batch = await getJournal('https://r', 'u', {}, fetchImpl);
        expect(batch.entries).toEqual([]);
        expect(batch.next_cursor).toBeNull();
    });
});

/** ─── deleteJournal ─── */

describe('deleteJournal', () => {
    it('DELETEs /v1/journal/{userHash}/{syncId}', async () => {
        const captured: { url: string; method?: string } = { url: '' };
        const fetchImpl: FetchLike = async (url, init) => {
            captured.url = url;
            captured.method = init?.method;
            return new Response(null, { status: 204 });
        };
        await deleteJournal('https://r', 'u', 'abc/def', fetchImpl);
        expect(captured.url).toBe('https://r/v1/journal/u/abc%2Fdef');
        expect(captured.method).toBe('DELETE');
    });
});

/** ─── Retry behavior ─── */

describe('retry/backoff', () => {
    it('retries 5xx then succeeds', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls++;
            if (calls <= 2) return new Response('boom', { status: 503 });
            return jsonResponse({ accepted: 1, rejected: [] });
        };
        const result = await postJournal('https://r', 'u', pushBatch(), fetchImpl);
        expect(result.accepted).toBe(1);
        expect(calls).toBe(3);
    });

    it('honors Retry-After on 429 then proceeds', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls++;
            if (calls === 1) {
                return new Response('slow down', {
                    status: 429,
                    headers: { 'retry-after': '3' },
                });
            }
            return jsonResponse({ accepted: 0, rejected: [] });
        };
        const result = await postJournal('https://r', 'u', pushBatch(), fetchImpl);
        expect(result.accepted).toBe(0);
        expect(calls).toBe(2);
    });

    it('throws after exhausting retries on persistent 5xx', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls++;
            return new Response('bad', { status: 500 });
        };
        await expect(postJournal('https://r', 'u', pushBatch(), fetchImpl)).rejects.toMatchObject({
            name: 'RelayError',
            status: 0,
        });
        expect(calls).toBe(5);
    });

    it('isRelayError type guard returns true for thrown errors and false for plain Errors', async () => {
        const fetchImpl: FetchLike = async () => new Response('bad', { status: 400 });
        let caught: unknown = null;
        try {
            await postJournal('https://r', 'u', pushBatch(), fetchImpl);
        } catch (err) {
            caught = err;
        }
        expect(isRelayError(caught)).toBe(true);
        expect(isRelayError(new Error('plain'))).toBe(false);
        expect(isRelayError('string')).toBe(false);
    });

    it('retries on a thrown network error then succeeds', async () => {
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls++;
            if (calls === 1) throw new Error('ECONNRESET');
            return jsonResponse({ accepted: 1, rejected: [] });
        };
        const result = await postJournal('https://r', 'u', pushBatch(), fetchImpl);
        expect(result.accepted).toBe(1);
    });
});
