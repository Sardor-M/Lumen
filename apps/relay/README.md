# `@lumen/relay`

Reference Cloudflare Worker implementation of the Lumen sync relay. Zero-knowledge journal storage backed by D1 (SQLite at the edge) and KV (rate-limit counters).

The relay holds **opaque ciphertext only**. Envelopes are sealed by the client with X25519 + XChaCha20-Poly1305 before they leave the device. The Worker cannot decrypt anything — it just routes blobs by `user_hash` (a one-way derivative of the client's master key). Lose the master key on every device and the data on the relay is permanently undecryptable; lose the relay and a fresh one rebuilds itself from any device's local SQLite. See [`docs/docs-temp/SYNC-PROTOCOL.md`](../../docs/docs-temp/SYNC-PROTOCOL.md) for the full protocol and threat model.

---

## What you get

Four endpoints, all keyed by `user_hash`:

| Method | Path                              | Purpose                                            |
| ------ | --------------------------------- | -------------------------------------------------- |
| POST   | `/v1/journal/:user_hash`          | Push a batch of encrypted entries                  |
| GET    | `/v1/journal/:user_hash`          | Pull since cursor, scope-tag filtered              |
| DELETE | `/v1/journal/:user_hash/:sync_id` | Tombstone (also drops the blob)                    |
| GET    | `/v1/health`                      | Liveness check, returns `{ok: true, version: "1"}` |

Wire format matches the relay client at [`apps/cli/src/sync/relay-client.ts`](../cli/src/sync/relay-client.ts) — the contract.

---

## Deploy

Prereqs: Cloudflare account, `wrangler` (installed as a dev dep here), and `pnpm`. The relay app is self-contained: install with `--ignore-workspace` to dodge an unrelated workspace mismatch in `apps/web`.

```bash
cd apps/relay
pnpm install --filter '@lumen/relay...' --ignore-workspace
```

### 1. Create the D1 database

```bash
pnpm wrangler d1 create lumen-relay
```

This prints a `database_id`. Paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "lumen-relay"
database_id = "PASTE_THE_ID_HERE"
migrations_dir = "migrations"
```

### 2. Create the KV namespace (rate limits)

```bash
pnpm wrangler kv namespace create RATE_LIMIT
```

Paste the `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_THE_ID_HERE"
```

If you don't want any rate limiting, just remove the `[[kv_namespaces]]` block entirely — the Worker treats a missing binding as "no limits".

### 3. Apply migrations

```bash
pnpm migrate:remote   # applies migrations/0001_init.sql to the production D1
```

For local dev:

```bash
pnpm migrate:local
```

### 4. Deploy

```bash
pnpm deploy
```

That's it. Wrangler prints the deployed URL; paste it into your client:

```bash
lumen sync init --relay https://lumen-relay.<your-account>.workers.dev
```

---

## Configuration

All knobs live in `wrangler.toml` `[vars]` — no code changes required to tune them.

| Variable                              |              Default | What it does                                                                     |
| ------------------------------------- | -------------------: | -------------------------------------------------------------------------------- |
| `MAX_ENVELOPE_BYTES`                  |    `262144` (256 KB) | Per-envelope size cap. Oversized entries are rejected with `reason: "oversize"`. |
| `MAX_BATCH_ENTRIES`                   |                `100` | Max entries per POST. Whole batch rejected with 413 if exceeded.                 |
| `MAX_PULL_LIMIT`                      |                `500` | Hard ceiling on `?limit=` for GET.                                               |
| `DEFAULT_PULL_LIMIT`                  |                `100` | Default `?limit=` when omitted.                                                  |
| `RATE_LIMIT_PUSH_REQUESTS_PER_MINUTE` |                 `50` | POSTs per minute per `user_hash`.                                                |
| `RATE_LIMIT_PULL_REQUESTS_PER_MINUTE` |                `100` | GETs per minute per `user_hash`.                                                 |
| `RATE_LIMIT_PUSH_ENTRIES_PER_HOUR`    |               `1000` | Sum of `entries.length` across pushes per hour.                                  |
| `RATE_LIMIT_BYTES_PER_DAY`            | `104857600` (100 MB) | Sum of POST `Content-Length` per day.                                            |

Set any rate limit to `"0"` to disable just that one. Limits respond with `429` + `Retry-After: <seconds>` and an RFC-7807 `application/problem+json` body.

---

## Local dev

```bash
pnpm dev
```

Boots a local workerd with a SQLite-backed D1 you can hit at `http://localhost:8787`. Apply migrations to the local DB once:

```bash
pnpm migrate:local
```

Sanity check:

```bash
curl -s http://localhost:8787/v1/health
# {"ok":true,"version":"1"}
```

Point a local Lumen CLI at it:

```bash
lumen sync init --relay http://localhost:8787
lumen sync enable
lumen sync run
```

---

## Tests

```bash
pnpm test
```

25 tests run inside real `workerd` + miniflare-backed D1 + KV via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) — no mocks. Each test file gets an isolated D1 with migrations auto-applied.

---

## Security guarantees

What the Worker **cannot** do:

- **Decrypt any payload** — envelopes are sealed with the client's master key, which the relay never sees.
- **Identify users beyond `user_hash`** — `user_hash` is a one-way function of `Kx`; no user metadata, no auth header, no session.
- **Modify a payload undetectably** — AEAD tag detects tampering on the client.

What it **can** do (honest limitations):

- Censor / drop traffic for a `user_hash` (DoS — the only meaningful attack vector).
- Correlate user activity to IP if not used over Tor / VPN (out of scope; users who need anonymity should self-host behind Tor or a VPN).
- **Soft rate limits under concurrency** — `checkAndIncrement` (`src/rate-limit.ts`) performs a KV read then a separate KV write with no atomic compare-and-swap. Two Worker invocations that overlap before either write completes will both read the same counter value, both pass the guard, and both increment — so a user can exceed any limit by up to *N − 1* where *N* is their concurrency. The `bytes` counter is the most sensitive: a client sending several large batches simultaneously can overshoot the daily byte budget without triggering a single 429. This is an accepted trade-off for v1 simplicity. Operators who need strict enforcement should migrate the counters to a **Cloudflare Durable Object**, which provides serialized access and true atomic updates.

If the data on the relay is leaked, an attacker sees a pile of opaque ciphertexts indexed by random-looking 16-character hashes. Without `Kx`, that's all they see.

---

## Architecture (one diagram)

```
  Device A                        Cloudflare Worker            Device B
  --------                        ----------------             --------

  capture                                                      sync pull
    |                                                            |
    v                                                            v
  appendJournal                  POST /v1/journal/{hx}        GET /v1/journal/{hx}
  encryptEnvelope    -------->   INSERT OR IGNORE   <-------- ?since=cursor
  postJournal                    journal_blobs(D1)            (returns entries)
                                                                |
                                                                v
                                                              decryptEnvelope
                                                              insertPulled
                                                              (Tier 5e applies)
```

Only the encrypted envelope ever crosses the wire. Local SQLite is the source of truth on both ends; the Worker is just a queue.

---

## Project links

- [Tier 5d spec](../../docs/docs-temp/TIER-5D-RELAY-WORKER.md) — design memo for this Worker
- [Sync protocol](../../docs/docs-temp/SYNC-PROTOCOL.md) — full umbrella spec
- [Relay client](../cli/src/sync/relay-client.ts) — the HTTP wrapper this Worker serves
- [Sync driver](../cli/src/sync/sync-driver.ts) — orchestrates push/pull on the device
