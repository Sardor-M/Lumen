-- Lumen relay D1 schema, v1.
--
-- The relay is a zero-knowledge journal store. Each row holds an opaque
-- AEAD-sealed envelope plus the routing metadata needed to filter pulls:
--   user_hash  — 16 hex chars, derived from the client's master key. Routes
--                blobs to a per-user keyspace; the relay cannot recover the
--                master key from this hash.
--   sync_id    — UUIDv7-shaped string assigned by the client. Sortable
--                lexicographically; serves as the pagination cursor.
--   envelope   — opaque blob (versioned JSON containing ciphertext + nonce
--                + ephemeral pubkey). The Worker never decodes this.
--   scope_tag  — HMAC-SHA256(Kx, scope_kind || ":" || scope_key)[:16].
--                Lets the client filter pulls by scope without leaking
--                scope identity to the relay.
--   received_at — server-side ISO timestamp at first receipt. Diagnostic
--                only; ordering is by sync_id, not received_at.
--
-- Idempotency: re-pushing a sync_id is a no-op via PRIMARY KEY conflict
-- (the Worker uses INSERT OR IGNORE).

CREATE TABLE IF NOT EXISTS journal_blobs (
    user_hash    TEXT NOT NULL,
    sync_id      TEXT NOT NULL,
    envelope     BLOB NOT NULL,
    scope_tag    TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    PRIMARY KEY (user_hash, sync_id)
);

-- Pull queries always filter by user_hash; sync_id ordering comes from the
-- PK directly. The scope index supports the optional scope-tag filter on
-- pulls.
CREATE INDEX IF NOT EXISTS idx_blobs_scope ON journal_blobs(user_hash, scope_tag);

-- Tombstone marker for tier-6 hard-delete propagation. In tier 5d the
-- DELETE endpoint inserts a tombstone AND removes the blob, so pulls
-- never surface deleted rows. Other devices learning about the deletion
-- (so they can drop their local copy) is a tier-6 concern; we keep the
-- tombstone for 30 days to be ready for that.
CREATE TABLE IF NOT EXISTS tombstones (
    user_hash    TEXT NOT NULL,
    sync_id      TEXT NOT NULL,
    deleted_at   TEXT NOT NULL,
    PRIMARY KEY (user_hash, sync_id)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_deleted_at ON tombstones(deleted_at);
