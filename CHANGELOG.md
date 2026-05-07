# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-05-05

### Added — End-to-end-encrypted cross-device sync (Tier 5)

Cross-device sync built as five additive sub-tiers. Local-first remains the default — the journal records every concept-touching mutation regardless of whether sync is enabled, and every payload is sealed with X25519 + XChaCha20-Poly1305 before it ever leaves the device. The relay sees only opaque ciphertext and never holds the master key.

- **Tier 5a — Sync journal foundation** (schema v15). Two new tables: `sync_state` (singleton, `CHECK id = 1`) and `sync_journal` (append-only log keyed by UUIDv7-shaped `sync_id`). Five mutator triggers (`upsertConcept`, `recordFeedback`, `updateCompiledTruth`, `retireConcept`, `captureTrajectory`) atomically append journal rows alongside their entity writes inside the same `db.transaction()` — a crash mid-write rolls both back. Per-process monotonic counter on `sync_id` guarantees within-millisecond sortability for cursor pagination.
- **Tier 5b — Encryption envelope** (`apps/cli/src/sync/crypto.ts`). Pure crypto module implementing the sealed-box scheme from `SYNC-PROTOCOL.md` §3: fresh ephemeral X25519 keypair per envelope, XChaCha20-Poly1305 with a 24-byte random nonce, recipient pubkey derived deterministically from the master key. Domain-separated derivations: `deriveUserHash` (relay routing), `deriveScopeRoutingTag` (per-scope filter via HMAC), `fingerprintMasterKey` (cross-device sanity check). Pure-TS deps (`@noble/ciphers`, `@noble/curves`); no native bindings.
- **Tier 5c — Relay HTTP client + push/pull driver + `lumen sync` CLI**. Three endpoints (POST/GET/DELETE journal, all keyed by `userHash`) with retry policy: max 5 attempts with backoff `[1s, 2s, 4s, 8s]`, `Retry-After` honored on 429, no sleep on the last attempt. `runPush` / `runPull` / `runSync` orchestrator with per-process consecutive-failure counter that opens a circuit-breaker after 5 failures (cleared via `lumen sync reset-error`). Keyring backends: macOS (`security` shell-out, key fed on stdin via `-w` no-arg form so it never appears in `ps`), Linux (`secret-tool`), file fallback (mode 0600), in-memory (tests). New CLI subcommands: `init` / `enable` / `disable` / `push` / `pull` / `run` / `status` / `reset-error` / `show-key --reveal` / `import-key <base64>` / `forget-key`.
- **Tier 5d — Reference Cloudflare Worker relay** (`apps/relay/`). Zero-knowledge journal storage backed by D1 + per-`user_hash` rate limiting via KV. Stores opaque envelopes; never holds the master key. Endpoints documented in `apps/relay/README.md`. Comes with a 25-test vitest suite via `@cloudflare/vitest-pool-workers`.
- **Tier 5e — Apply rules + LWW conflict resolution** (schema v16). `applyPending(opts?)` walks `pulled_at IS NOT NULL AND applied_at IS NULL` rows and dispatches to per-op handlers (`applyConceptCreate`, `applyTrajectory`, `applyFeedback`, `applyTruthUpdate`, `applyRetire`). Each handler writes direct SQL that bypasses the journaling mutators (so applied entries don't re-journal and bounce back to the relay). Per-entry transactional boundary — if apply throws, `markApplied` rolls back so the next call retries. Last-write-wins on `truth_update` with strict `>` comparison: ties (equal `updated_at`) keep the local truth and skip the audit row; real losses (strictly older incoming) land in `concept_truth_history` with `superseded_by` set. New table: `concept_truth_history`. New CLI subcommand: `lumen sync apply` (also baked into `lumen sync run` after push → pull).

### Added — Tests

- **132 new sync tests** across the five sub-tiers:
    - `sync-journal.test.ts` (21) — schema v15, state singleton, journal CRUD, write-path triggers
    - `sync-crypto.test.ts` (23) — master key, derivations, encrypt/decrypt round-trip + tamper + version + size
    - `sync-keyring.test.ts` (14) — memory + file backend round-trip + mode 0600 + env-var selection
    - `sync-relay-client.test.ts` (15) — POST/GET/DELETE shape, retry policy, `Retry-After`, type guard
    - `sync-driver.test.ts` (22) — push/pull/sync round-trip, idempotency, scope tags, circuit-breaker, terminal-page cursor
    - `sync-apply.test.ts` (28) — per-op handlers, LWW won/lost/tie, idempotency, orchestrator
    - `sync-e2e.test.ts` (4) — full cross-device flow (A → relay → B) verifying ciphertext opacity + state convergence
    - 5 additions in pre-existing tests for write-path trigger behavior
- **25 relay tests** in `apps/relay/test/` via `@cloudflare/vitest-pool-workers`.
- Suite total: **866 passing**, 2 skipped, 11 todo (was 740 in 0.1.4).

### Changed

- `lumen sync show-key --reveal` writes the base64 master key via `process.stdout.write` (no log prefix) so it pipes/copies cleanly.
- `RelayError` is a branded type rather than a class (project-wide no-classes rule); use `isRelayError(err)` instead of `instanceof`.
- `lumen sync run` runs **push → pull → apply** in one cycle by default. Apply doesn't touch the network, so apply failures don't trip the circuit-breaker.

### Schema migrations

- **v15** — `sync_state` singleton + append-only `sync_journal` (CHECK on `op` enum, indexes on `pushed_at` / `op` / `(scope_kind, scope_key)` / `applied_at`).
- **v16** — `concept_truth_history` (last-write-wins audit; nullable `truth` since the displaced row may have been null) + partial UNIQUE INDEX on `concept_feedback(sync_id) WHERE sync_id IS NOT NULL` for apply idempotency.

Both purely additive; existing tables and prior tests untouched.

### Dependencies

- `@noble/ciphers ^1.0.0`, `@noble/curves ^1.6.0` — pure-TS, audited (Paul Miller / Noble suite), ~10 KB each, no native bindings.

### What's NOT in this release

- Multi-device key share UI — QR / BIP39 phrase / age file. Tier 6, deferred. Cross-device onboarding currently means `lumen sync show-key --reveal` on device A → `lumen sync import-key <base64>` on device B.
- Background sync scheduler. Tier 6, deferred. Push/pull is currently manual via CLI.

## [0.1.4] - 2026-04-23

### Added

- Ingest expansion — three new source types and one new connector, all additive to the existing `sources`/`chunks` schema via the JSON `metadata` column:
    - **Code repositories** (`source_type: 'code'`) — `lumen add <github-url>` clones shallowly into `os.tmpdir()` and cleans up; `lumen add ./path` reads in place and captures `commit_sha` + `branch` when `.git` is present. Honours `.gitignore`, hard-skips `node_modules` / `dist` / `.next` / `target` / etc., truncates files over 50 KB, caps at 800 files per repo. Lightweight regex extracts top-level function/class/type/interface signatures for JavaScript, TypeScript, Python, Go, Rust, Java, C/C++, Ruby, C#. `README.md` / `CONTRIBUTING.md` / `docs/` are ordered before source sections.
    - **Datasets** (`source_type: 'dataset'`) — `lumen add ./data.csv` or `lumen add https://huggingface.co/datasets/<id>`. Native CSV / TSV / JSONL parsing (quoted fields with doubled-quote escapes, delimiter auto-detection); HuggingFace datasets fetched via the `/api/datasets/` endpoint plus `/raw/main/README.md` for the card. Each dataset produces a schema table (column name, inferred type, null count in sample) and a 20-row preview rendered as markdown. Colocated `README.md` / `dataset-card.md` auto-inlined.
    - **Images** (`source_type: 'image'`) — `lumen add screenshot.png`. SHA-256 of image bytes computed into metadata; MIME inferred from extension. Optional OCR shells out to a local `tesseract` binary when it's on `PATH`; `--no-ocr` skips and stores metadata only. Missing binary produces a clear install hint (`brew install tesseract`) rather than failing the ingest. Supported: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.tiff`.
    - **Obsidian connector** (`ConnectorType: 'obsidian'`) — `lumen watch add obsidian ~/vault`. Watches a vault (or optional `subdir`), parses YAML frontmatter produced by the Obsidian Web Clipper, and promotes the `source:` URL into the `ExtractionResult` so re-clippings of the same article dedup by URL. Skips the `.obsidian` metadata folder and other dotfiles. Flat keys, inline arrays, and block-list arrays all supported.
- Auto-detection in `detectSourceType`: GitHub repo URL → `code`, HuggingFace dataset URL → `dataset`, `.csv` / `.tsv` / `.jsonl` / `.ndjson` → `dataset`, image extensions → `image`, directory containing `.git` → `code`.
- `add` command options: `--as-dataset` (force dataset handling), `--no-ocr` (skip OCR on images). `lib/add.ts` `AddInput` object form accepts an `options` field, threading `IngestOptions` through the programmatic ingest path.
- 77 new tests across `tests/code.test.ts` (20), `tests/dataset.test.ts` (20), `tests/image.test.ts` (12, one conditionally skipped when tesseract is absent), `tests/obsidian.test.ts` (19), and 7 new assertions in `tests/ingest.test.ts` for the widened `detectSourceType`. Total suite: 534 passing, 2 skipped.

### Changed

- `SourceType` union widened to `'url' | 'pdf' | 'youtube' | 'arxiv' | 'file' | 'folder' | 'code' | 'dataset' | 'image'`. No schema migration needed — the existing `source_type TEXT` column and `metadata TEXT` JSON column already accept any string / blob.
- `ConnectorType` union widened with `'obsidian'`. `watch add obsidian <vault>` becomes the recommended path for ambient browser clippings (via the Obsidian Web Clipper extension).
- `apps/cli/src/ingest/file.ts` `ingestInput` accepts an optional `IngestOptions` second argument; signature is backwards-compatible for existing callers.

### Deferred (tracked in `docs/docs-temp/INGEST-EXPANSION-PLAN.md`)

- Tree-sitter-based code parsing — current implementation uses lightweight per-language regex for signatures, which is sufficient for BM25 discovery but misses nested/complex declarations. Deferred to avoid a native-build dependency.
- Claude Vision caption pass on `compile` for images — `metadata.caption` is reserved as a placeholder; no model call yet.
- Native Parquet support — `.parquet` errors with a `duckdb` conversion hint rather than parsing. Adding `parquetjs-lite` felt like too much surface area for the current iCloud-synced dev environment.
- In-house browser extension for clippings — Obsidian path is expected to validate the flow before investing in a separate extension.

## [0.1.3] - 2026-04-22

### Added

- Landing page app (`apps/landing`) with interactive graph, knowledge model, agent wiring demos
- Shared `packages/ui` with `useClipboard` hook
- Shared `packages/eslint-config` for Next.js flat config
- Shared `packages/tsconfig` and `packages/brand`
- Benchmarks runner (`benchmarks/`) with search quality, latency, graph ops, adversarial, MCP contract tests
- npm/GitHub badges and links section in root README
- `npm install -g lumen-kb` as primary install path

### Fixed

- `useClipboard`: await clipboard `writeText` Promise before setting `copied` state
- `@eslint/eslintrc` added as explicit dependency in `packages/eslint-config`
- `bench` script routes through workspace tsx instead of missing root dep
- `@claude` workflow: `allowed_tools` moved into `claude_args` as `--allowedTools` flag
- Auto-review diff limit raised from 2000 to 4000 lines
- Landing JSX comment lint errors (wrapped `//` text in braces)
- `.gitignore` iCloud `node_modules 2` pattern escaped correctly

## [0.1.2] - 2026-04-21

### Added

- `compile` MCP tool — agents can ingest + compile in one flow (19 tools total)
- `CLAUDE.md` brain-first protocol generated by `lumen install claude`
- `compile -c <n>` parallel compilation via pre-partitioned stride workers
- `compile --model <model>` override LLM model per run
- `search -b <tokens>` budget flag to cap results by token count
- Source citations in skill: `[Source: title]` format
- `LUMEN_DIR` baked into `.mcp.json` by `lumen install claude`
- Compress pipeline tests (13 tests)
- Graph engine + PageRank + communities tests (15 tests)
- Delta module test stubs (10 todos)

### Fixed

- Default model changed from invalid `claude-sonnet-4-20250514` to `claude-sonnet-4-6`
- `~/.lumen/.env` always checked as fallback for API keys
- Hooks format updated to `{ matcher, hooks: [{ type, command }] }` for Claude Code v2.1+
- Worker pool race: shared queue replaced with pre-partitioned stride
- `invalidateProfile` moved back inside `withBatchedInvalidation` callback
- `parseInt` radix + NaN guard for `--budget` flag
- Prepared statement hoisted outside budget loop

### Changed

- License changed from PolyForm Shield 1.0.0 to MIT
- CI review prompt shortened (under 400/800 words, max 2 nits)
- `@claude` workflow pinned to Sonnet 4.6

## [0.1.0] - 2026-04-17

### Added

- Signal capture MCP tools: `capture`, `session_summary`, `brain_ops`
- Tiered entity enrichment engine (Tier 3 → 2 → 1) with auto-queue on compile
- Schema v9: `enrichment_tier`, `last_enriched_at`, `enrichment_queued` on concepts
- `lumen enrich` command with `--status` and `--all` flags
- Anthropic prompt caching (`cache_control: ephemeral`) on system prompts
- `chatAnthropicStream` for token-by-token streaming in `lumen ask`
- Always-on brain protocol skill for Claude Code
- Stop hook (`lumen-signal.sh`) for passive knowledge capture
- `brain_ops` MCP tool with auto-intent detection

## [0.0.1] - 2026-04-10

### Added

- Initial release
- Multi-format ingestion: URL, PDF, YouTube, arXiv, file, folder
- Structural chunking (Markdown, HTML, plain text) with merge/split
- SHA-256 content-addressed deduplication
- BM25 search via SQLite FTS5 (Porter stemmed)
- TF-IDF search via in-memory inverted index
- Vector ANN search via sqlite-vec (OpenAI / Ollama embeddings)
- Reciprocal Rank Fusion (3-signal merge, k=60)
- Knowledge graph: concepts, weighted edges, compiled truth + timeline
- Graph algorithms: PageRank, BFS shortest path, neighborhood, label propagation
- 4-stage compression pipeline
- Profile with caching and invalidation
- MCP server (stdio, 15 tools)
- `lumen install claude` / `lumen install codex`
- Web UI (Next.js 15, Better Auth, shadcn)
- Claude Code PR review workflow
