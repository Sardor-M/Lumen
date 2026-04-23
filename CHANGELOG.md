# Changelog

All notable changes to this project will be documented in this file.

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
