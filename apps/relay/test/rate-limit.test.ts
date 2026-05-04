/**
 * Rate-limit tests. Each test posts under a unique user_hash so counters
 * don't bleed between tests, and uses tiny limits via env override so we
 * don't have to make hundreds of requests to trip them.
 *
 * The Worker reads RATE_LIMIT_* via c.env, but those are set per-Worker via
 * wrangler.toml [vars] and can't easily be patched per-test. Instead, these
 * tests call the live KV directly to pre-seed counters at the limit, then
 * confirm the next request is 429'd.
 */

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OTHER_USER_HASH, USER_HASH, makeEntry, postBatch, get } from './helpers.js';
import { checkAndIncrement } from '../src/rate-limit.js';

const BASE = 'https://relay.test';

describe('rate limiting', () => {
    it('returns 429 + Retry-After when push_req counter is at the limit', async () => {
        /**
         * Pre-seed the counter at exactly the production limit (50/min) for
         * a fresh user_hash, then issue the next request and expect 429.
         */
        const userHash = '1234567890abcdef';
        const limit = 50;
        for (let i = 0; i < limit; i++) {
            await checkAndIncrement(env.RATE_LIMIT, userHash, 'push_req', 1, limit, 60);
        }
        const res = await SELF.fetch(`${BASE}/v1/journal/${userHash}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_id: 'd', entries: [] }),
        });
        expect(res.status).toBe(429);
        const ra = res.headers.get('retry-after');
        expect(ra).not.toBeNull();
        expect(Number.parseInt(ra ?? '0', 10)).toBeGreaterThan(0);
        const body = (await res.json()) as { type: string; status: number; retry_after: number };
        expect(body.type).toBe('rate_limit_exceeded');
        expect(body.status).toBe(429);
    });

    it('returns 429 when pull_req counter is at the limit', async () => {
        const userHash = 'fedcba0987654321';
        const limit = 100;
        for (let i = 0; i < limit; i++) {
            await checkAndIncrement(env.RATE_LIMIT, userHash, 'pull_req', 1, limit, 60);
        }
        const res = await SELF.fetch(`${BASE}/v1/journal/${userHash}`);
        expect(res.status).toBe(429);
    });

    it('counts entry-volume against push_entries limit', async () => {
        const userHash = '0123456789abcdef';
        const limit = 1000;
        await checkAndIncrement(env.RATE_LIMIT, userHash, 'push_entries', limit, limit, 3600);
        const { status } = await postBatch(userHash, [makeEntry()]);
        expect(status).toBe(429);
    });

    it('falls through (no 429) when the per-user counter is below limit', async () => {
        /** Sanity check: regular traffic for OTHER_USER_HASH is not rate-limited. */
        const r1 = await postBatch(OTHER_USER_HASH, [makeEntry()]);
        expect(r1.status).toBe(200);
        const r2 = await get(OTHER_USER_HASH);
        expect(r2.status).toBe(200);
    });
});

describe('checkAndIncrement (unit)', () => {
    it('returns ok=true when limit is 0 (disabled)', async () => {
        const r = await checkAndIncrement(env.RATE_LIMIT, USER_HASH, 'push_req', 1, 0, 60);
        expect(r.ok).toBe(true);
    });

    it('returns ok=true when kv binding is undefined', async () => {
        const r = await checkAndIncrement(undefined, USER_HASH, 'push_req', 1, 100, 60);
        expect(r.ok).toBe(true);
    });

    it('rejects when current + increment > limit, with retry_after > 0', async () => {
        const userHash = '7777777777777777';
        await checkAndIncrement(env.RATE_LIMIT, userHash, 'pull_req', 5, 5, 60);
        const r = await checkAndIncrement(env.RATE_LIMIT, userHash, 'pull_req', 1, 5, 60);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.kind).toBe('pull_req');
            expect(r.retry_after).toBeGreaterThan(0);
        }
    });
});
