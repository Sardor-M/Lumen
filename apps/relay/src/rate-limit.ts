/**
 * Per-user-hash rate limiting via KV-backed fixed-window counters.
 *
 * Four counters per user:
 *   push_req      — POST /v1/journal/:user_hash requests, per minute
 *   pull_req      — GET  /v1/journal/:user_hash requests, per minute
 *   push_entries  — sum of `entries.length` across pushes, per hour
 *   bytes         — sum of POST content-length, per day
 *
 * Window = floor(now / windowSeconds). Bucket key encodes the window so
 * each window is a fresh counter, and we set TTL = 2 × windowSeconds so
 * old buckets clean themselves up.
 *
 * Read-modify-write race: two concurrent requests can both read N and
 * write N+1, so a user can briefly exceed the limit by `concurrency`.
 * Acceptable for v1 — Durable Objects would fix it but the doc explicitly
 * picks "KV with TTL for a simpler v1" (TIER-5D-RELAY-WORKER.md).
 *
 * Soft-fail: if `kv` is undefined OR `limit <= 0`, the check returns
 * `{ ok: true }` immediately. Self-hosters who don't want rate limits can
 * omit the KV binding or set the limit env vars to 0.
 */

export type RateLimitKind = 'push_req' | 'pull_req' | 'push_entries' | 'bytes';

export type RateLimitResult =
    | { ok: true }
    | { ok: false; retry_after: number; kind: RateLimitKind };

/**
 * Atomically (within a single Worker invocation) check whether
 * `current + increment > limit`, and if not, increment the counter.
 * Returns `retry_after` seconds when the limit is hit.
 */
export async function checkAndIncrement(
    kv: KVNamespace | undefined,
    userHash: string,
    kind: RateLimitKind,
    increment: number,
    limit: number,
    windowSeconds: number,
    nowMs: number = Date.now(),
): Promise<RateLimitResult> {
    if (!kv || limit <= 0 || increment <= 0) return { ok: true };

    const nowSec = Math.floor(nowMs / 1000);
    const window = Math.floor(nowSec / windowSeconds);
    const key = `rl:${userHash}:${kind}:${window}`;

    const current = Number.parseInt((await kv.get(key)) ?? '0', 10) || 0;
    if (current + increment > limit) {
        const nextWindowAtSec = (window + 1) * windowSeconds;
        const retry_after = Math.max(1, nextWindowAtSec - nowSec);
        return { ok: false, retry_after, kind };
    }
    await kv.put(key, String(current + increment), {
        /** KV TTL minimum is 60s; clamp anything shorter. */
        expirationTtl: Math.max(60, windowSeconds * 2),
    });
    return { ok: true };
}
