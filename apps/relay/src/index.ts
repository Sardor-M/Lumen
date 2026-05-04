/**
 * Lumen relay — reference Cloudflare Worker implementation.
 *
 * Zero-knowledge journal store: accepts opaque encrypted envelopes from clients,
 * indexes them by `user_hash` (a one-way derivative of the client's master key),
 * serves them back via cursor-paginated GET. The Worker cannot decrypt anything;
 * envelopes are sealed with X25519 + XChaCha20-Poly1305 on the device before
 * they ever leave.
 *
 * Wire format matches `apps/cli/src/sync/relay-client.ts`. See SYNC-PROTOCOL.md
 * for the full design memo and TIER-5D-RELAY-WORKER.md for this tier's scope.
 */

import { Hono } from 'hono';

export type Bindings = {
    DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/v1/health', (c) => c.json({ ok: true, version: '1' }));

export default app;
