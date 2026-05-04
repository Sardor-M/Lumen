/**
 * Input validation + RFC-7807 problem+json error helpers.
 *
 * The relay sees only opaque ciphertext and routing tags; we still validate
 * shape so a malformed request can't slip past the SQL boundary.
 */

import type { Context } from 'hono';
import type { EncryptionEnvelope, PushEntry } from './types.js';

/** user_hash is 16 lowercase hex chars (per SYNC-PROTOCOL.md §2). */
const USER_HASH_RE = /^[0-9a-f]{16}$/;
/**
 * scope_routing_tag is 16 lowercase hex chars
 * (HMAC-SHA256(Kx, scope_kind || ":" || scope_key)[:16]).
 */
const SCOPE_TAG_RE = /^[0-9a-f]{16}$/;
/**
 * sync_id is a UUIDv7-shaped lowercase hex string (no dashes). The client
 * generates 32 hex chars (12 ms + 4 monotonic + 16 random) but accepting a
 * range here keeps the relay forward-compatible with id-format tweaks.
 */
const SYNC_ID_RE = /^[0-9a-f]{16,64}$/;

export function isValidUserHash(s: string): boolean {
    return USER_HASH_RE.test(s);
}

export function isValidScopeTag(s: string): boolean {
    return SCOPE_TAG_RE.test(s);
}

export function isValidSyncId(s: string): boolean {
    return SYNC_ID_RE.test(s);
}

export function isValidEnvelope(v: unknown): v is EncryptionEnvelope {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    return (
        o.v === 1 && typeof o.e === 'string' && typeof o.n === 'string' && typeof o.c === 'string'
    );
}

export function isValidPushEntry(v: unknown): v is PushEntry {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    return (
        typeof o.sync_id === 'string' &&
        isValidSyncId(o.sync_id) &&
        typeof o.scope_routing_tag === 'string' &&
        isValidScopeTag(o.scope_routing_tag) &&
        isValidEnvelope(o.envelope)
    );
}

/** Approximate byte size of the envelope's JSON serialization. */
export function envelopeByteSize(envelope: EncryptionEnvelope): number {
    return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}

/** Read a tunable from `Bindings` (string env var) with a fallback. */
export function readNumberVar(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build an RFC-7807 problem+json response. The relay client (line 144 of
 * relay-client.ts) concats the body into its error message, so a JSON
 * problem doc renders cleanly in user-facing logs.
 */
export type ProblemDetails = {
    type: string;
    title: string;
    status: number;
    detail?: string;
    /** Seconds until the client should retry; mirrored to the Retry-After header. */
    retry_after?: number;
};

export function problem(c: Context, problem: ProblemDetails): Response {
    const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
    if (typeof problem.retry_after === 'number') {
        headers['retry-after'] = String(problem.retry_after);
    }
    return c.body(JSON.stringify(problem), problem.status as 400 | 404 | 413 | 429, headers);
}

export function badRequest(c: Context, detail: string): Response {
    return problem(c, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail,
    });
}

export function payloadTooLarge(c: Context, detail: string): Response {
    return problem(c, {
        type: 'about:blank',
        title: 'Payload Too Large',
        status: 413,
        detail,
    });
}
