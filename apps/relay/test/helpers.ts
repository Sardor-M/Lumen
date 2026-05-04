/**
 * Test helpers for building well-formed push entries and exercising the relay
 * via SELF.fetch (vitest-pool-workers' bound-to-the-deployed-Worker fetcher).
 */

import { SELF } from 'cloudflare:test';
import type { EncryptionEnvelope, PushEntry, PushResult, PullBatch } from '../src/types.js';

const BASE = 'https://relay.test';

export const USER_HASH = 'aaaaaaaaaaaaaaaa';
export const OTHER_USER_HASH = 'bbbbbbbbbbbbbbbb';
export const SCOPE_A = '1111111111111111';
export const SCOPE_B = '2222222222222222';

let counter = 0;
const RUN_ID = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(12, '0')
    .slice(-12);

/**
 * Build a deterministic, lexicographically-sortable sync_id for tests.
 * Format mirrors the client's UUIDv7 shape (12 hex ms + 4 hex monotonic +
 * 16 hex padding) so the relay's sync_id ordering tests behave realistically.
 */
export function makeSyncId(seq?: number): string {
    const n = seq ?? ++counter;
    const monotonic = n.toString(16).padStart(4, '0').slice(-4);
    const tail = '0'.repeat(16);
    return `${RUN_ID}${monotonic}${tail}`;
}

export function makeEnvelope(label = 'envelope'): EncryptionEnvelope {
    const enc = (s: string) => Buffer.from(s).toString('base64');
    return {
        v: 1,
        e: enc(`pubkey-${label}`),
        n: enc(`nonce-${label}`),
        c: enc(`ciphertext-${label}`),
    };
}

export function makeEntry(
    opts: { syncId?: string; scopeTag?: string; label?: string } = {},
): PushEntry {
    return {
        sync_id: opts.syncId ?? makeSyncId(),
        envelope: makeEnvelope(opts.label),
        scope_routing_tag: opts.scopeTag ?? SCOPE_A,
    };
}

export async function postBatch(
    userHash: string,
    entries: PushEntry[],
    deviceId = 'device-test',
): Promise<{ status: number; body: PushResult }> {
    const res = await SELF.fetch(`${BASE}/v1/journal/${userHash}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, entries }),
    });
    const body = res.ok
        ? ((await res.json()) as PushResult)
        : ({ accepted: 0, rejected: [] } as PushResult);
    return { status: res.status, body };
}

export async function get(
    userHash: string,
    opts: { since?: string; limit?: number; scopeTags?: string[] } = {},
): Promise<{ status: number; body: PullBatch }> {
    const params = new URLSearchParams();
    if (opts.since) params.set('since', opts.since);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    for (const t of opts.scopeTags ?? []) params.append('scope', t);
    const qs = params.toString();
    const res = await SELF.fetch(`${BASE}/v1/journal/${userHash}${qs ? `?${qs}` : ''}`, {
        method: 'GET',
    });
    const body = res.ok
        ? ((await res.json()) as PullBatch)
        : ({ entries: [], next_cursor: null } as PullBatch);
    return { status: res.status, body };
}

export async function deleteEntry(userHash: string, syncId: string): Promise<{ status: number }> {
    const res = await SELF.fetch(`${BASE}/v1/journal/${userHash}/${syncId}`, {
        method: 'DELETE',
    });
    return { status: res.status };
}
