/**
 * HTTP client for the relay (Tier 5d ships the reference Cloudflare Worker).
 *
 * Three endpoints, all keyed by `userHash`:
 *   POST   {relayUrl}/v1/journal/{userHash}             — push batch
 *   GET    {relayUrl}/v1/journal/{userHash}?since=...   — pull since cursor
 *   DELETE {relayUrl}/v1/journal/{userHash}/{syncId}    — tombstone (Tier 6)
 *
 * Retry policy:
 *   - 5xx: exponential backoff [1s, 2s, 4s, 8s], capped at 60s, max 5 attempts
 *   - 429: honor `Retry-After` header (seconds, integer); fall back to backoff
 *   - 4xx (non-429): no retry, throw with response body
 *   - Network errors: same backoff as 5xx
 *
 * Circuit-break is a higher-level concern handled in `sync-driver.ts`. This
 * module just retries individual requests.
 */

import type { EncryptionEnvelope } from './crypto.js';

export type PushEntry = {
    sync_id: string;
    envelope: EncryptionEnvelope;
    scope_routing_tag: string;
};

export type PushBatch = {
    device_id: string;
    entries: PushEntry[];
};

export type PushResult = {
    accepted: number;
    rejected: Array<{ sync_id: string; reason: string }>;
};

export type PullEntry = {
    sync_id: string;
    envelope: EncryptionEnvelope;
    scope_routing_tag: string;
    received_at: string;
};

export type PullBatch = {
    entries: PullEntry[];
    next_cursor: string | null;
};

export type GetJournalOptions = {
    since?: string;
    limit?: number;
    scopeTags?: string[];
};

/** Injectable for tests; defaults to global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

export async function postJournal(
    relayUrl: string,
    userHash: string,
    batch: PushBatch,
    fetchImpl: FetchLike = fetch,
): Promise<PushResult> {
    const url = `${trimSlash(relayUrl)}/v1/journal/${encodeURIComponent(userHash)}`;
    const res = await retrying(
        () =>
            fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(batch),
            }),
        'POST journal',
    );
    const body = (await res.json()) as Partial<PushResult>;
    return {
        accepted: typeof body.accepted === 'number' ? body.accepted : 0,
        rejected: Array.isArray(body.rejected) ? body.rejected : [],
    };
}

export async function getJournal(
    relayUrl: string,
    userHash: string,
    opts: GetJournalOptions = {},
    fetchImpl: FetchLike = fetch,
): Promise<PullBatch> {
    const params = new URLSearchParams();
    if (opts.since) params.set('since', opts.since);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    for (const tag of opts.scopeTags ?? []) params.append('scope', tag);
    const qs = params.toString();
    const url = `${trimSlash(relayUrl)}/v1/journal/${encodeURIComponent(userHash)}${qs ? `?${qs}` : ''}`;
    const res = await retrying(() => fetchImpl(url, { method: 'GET' }), 'GET journal');
    const body = (await res.json()) as Partial<PullBatch>;
    return {
        entries: Array.isArray(body.entries) ? body.entries : [],
        next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
    };
}

export async function deleteJournal(
    relayUrl: string,
    userHash: string,
    syncId: string,
    fetchImpl: FetchLike = fetch,
): Promise<void> {
    const url = `${trimSlash(relayUrl)}/v1/journal/${encodeURIComponent(userHash)}/${encodeURIComponent(syncId)}`;
    await retrying(() => fetchImpl(url, { method: 'DELETE' }), 'DELETE journal');
}

/**
 * Run `attempt` with retry/backoff. Treats 5xx, 429, and network errors as
 * retryable; 4xx (non-429) throws immediately.
 *
 * On 429 with a numeric `Retry-After`, sleep for that many seconds (capped at
 * BACKOFF_CAP_MS). Otherwise back off exponentially: 1s, 2s, 4s, 8s, 16s.
 */
async function retrying(attempt: () => Promise<Response>, label: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const res = await attempt();
            if (res.status >= 200 && res.status < 300) return res;

            if (res.status === 429) {
                const ra = parseRetryAfter(res.headers.get('retry-after'));
                await sleep(ra ?? backoffMs(i));
                continue;
            }
            if (res.status >= 500) {
                await sleep(backoffMs(i));
                continue;
            }
            /** 4xx (non-429): non-retryable. Pull the body for diagnostics. */
            const body = await res.text().catch(() => '');
            throw new RelayError(
                `${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
                res.status,
            );
        } catch (err) {
            if (err instanceof RelayError) throw err;
            lastErr = err;
            await sleep(backoffMs(i));
        }
    }
    throw new RelayError(
        `${label} exhausted ${MAX_RETRIES} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        0,
    );
}

export class RelayError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = 'RelayError';
    }
}

function backoffMs(attemptIndex: number): number {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, attemptIndex), BACKOFF_CAP_MS);
}

function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number.parseInt(value, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, BACKOFF_CAP_MS);
}

function sleep(ms: number): Promise<void> {
    /** Tests set LUMEN_RELAY_NO_BACKOFF to skip the real backoff and stay fast. */
    if (process.env.LUMEN_RELAY_NO_BACKOFF) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}
