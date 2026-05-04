/**
 * Wire-format types matching `apps/cli/src/sync/relay-client.ts`. The Worker
 * is a server-side reflection of the same contract; if the client ships a
 * change here, the Worker must follow.
 */

export type Bindings = {
    DB: D1Database;
    /** Per-envelope size cap, bytes. From wrangler.toml [vars]. */
    MAX_ENVELOPE_BYTES?: string;
    /** Max entries accepted per POST batch. From wrangler.toml [vars]. */
    MAX_BATCH_ENTRIES?: string;
    /** Hard ceiling on `limit` query param for GET. From wrangler.toml [vars]. */
    MAX_PULL_LIMIT?: string;
    /** Default `limit` when query param omitted. From wrangler.toml [vars]. */
    DEFAULT_PULL_LIMIT?: string;
};

/**
 * Encryption envelope as produced by the client's crypto module. Opaque to
 * the Worker — never decoded, never inspected, just stored and returned.
 */
export type EncryptionEnvelope = {
    v: 1;
    /** base64 ephemeral X25519 public key (32 bytes). */
    e: string;
    /** base64 XChaCha20-Poly1305 nonce (24 bytes). */
    n: string;
    /** base64 ciphertext + 16-byte AEAD tag. */
    c: string;
};

export type PushEntry = {
    sync_id: string;
    envelope: EncryptionEnvelope;
    scope_routing_tag: string;
};

export type PushBatch = {
    device_id: string;
    entries: PushEntry[];
};

export type PushRejection = {
    sync_id: string;
    reason: 'duplicate' | 'invalid_envelope' | 'invalid_sync_id' | 'invalid_scope_tag' | 'oversize';
};

export type PushResult = {
    accepted: number;
    rejected: PushRejection[];
};

export type PullEntry = {
    sync_id: string;
    envelope: EncryptionEnvelope;
    scope_routing_tag: string;
    received_at: string;
};

export type PullBatch = {
    entries: PullEntry[];
    /** sync_id of the last entry returned, or null if no more rows after this page. */
    next_cursor: string | null;
};
