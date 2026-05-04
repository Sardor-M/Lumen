# Lumen

[![npm](https://img.shields.io/npm/v/lumen-kb)](https://www.npmjs.com/package/lumen-kb)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE.md)
[![GitHub](https://img.shields.io/github/stars/Sardor-M/Lumen?style=social)](https://github.com/Sardor-M/Lumen)

AI agents start every conversation with amnesia. Claude Code, Cursor, Codex, your Mastra or LangChain harness — they all know the world but nothing about _your_ world: the 200 papers you've read, the codebase you ship, the architecture decisions you made last quarter, the trajectory that finally worked when you debugged that thing at 2am. Every session relearns the same context, repeats the same mistakes, forgets your corrections an hour later, and burns your token budget re-explaining the same domain.

Lumen is the substrate that fixes that — a local-first knowledge compiler that gives your agent a persistent brain. Drop everything you've read, shipped, or captured into it (articles, papers, YouTube talks, whole code repositories, datasets, screenshots of dashboards, Obsidian clippings) and it builds a SQLite-backed knowledge graph the agent can search before it answers. Successful multi-step tool sequences are saved as replayable trajectories so the agent doesn't relearn the same task next week. Concepts accumulate `+1`/`-1` feedback, near-duplicates merge into canonicals on write, and the whole graph is scope-aware so work in repo A doesn't pollute results in repo B.

`lumen install claude` wires this directly into Claude Code with a brain-first `CLAUDE.md` protocol: check the brain before the internet, cite sources, capture new ideas after every response. The same MCP server (23 tools) plugs into Cursor, Codex, or any MCP client. Native adapters under `lumen-kb/{openai,ai-sdk,langchain,mastra}` cover everything else. Every conversation draws from and adds to the brain automatically — the difference compounds daily.

Everything runs on your machine. One SQLite file. No cloud, no server. The LLM is only called when you ask it to compile or synthesize — search, indexing, graph traversal, deduplication, scope routing, and PII scrubbing all run locally. Opt-in end-to-end-encrypted sync across your devices is wired in: every concept-touching mutation lands in an append-only journal, sealed with X25519 + XChaCha20-Poly1305 before it leaves the box, and pushes to a self-hostable Cloudflare Worker relay (`apps/relay/`, deployable in three `wrangler` commands) that holds opaque ciphertext only — the relay never sees the key.

---

## Architecture

```
    INGEST              CHUNK               STORE              SEARCH
    ------              -----               -----              ------

  URL      -+         +- Markdown         +- Sources         +- BM25 (FTS5)
  PDF      -|         |                   |                  |
  YouTube  -+         +- HTML             +- Chunks          +- TF-IDF
  arXiv    -|- Extract|                -> |                -> |
  File/Dir -|         +- Plain text       +- Concepts        +- Vector ANN
  Code     -|         |                   +- Edges           |
  Dataset  -|         +- Code + sigs      +- Aliases         +- Graph walk
  Image    -|         |                   +- Trajectories           |
  Obsidian -+         +- Schema tables    +- Embeddings             v
                                                              RRF Fusion
    COMPILE             ENRICH              GRAPH         (3-signal merge)
    -------             ------              -----                   |
                                                                Budget cut
  LLM extracts       Tier scoring        PageRank                   |
  concepts +         escalates           Path finding          Ranked chunks
  compiled truth     stubs ->            Community                  |
  + timeline         rich pages          detection                  v
  per source         via LLM             Visualization        LLM synthesis
  (parallel)                                                   (streaming)

           SCOPE                 FEEDBACK              PII GATE
           -----                 --------              --------

  Codebase / framework /     +1 / -1 votes        Regex scrubber on
  language / personal /      score >=  +N          captures + sessions
  team. Per-source +         score <= -3 retires  (tokens, emails, JWTs,
  per-concept routing.       Aliases on write     credit cards, paths)

       TRAJECTORY            REVIEW PASS              SYNC JOURNAL
       ----------            -----------              ------------

  Tool-call sequences    LLM scans completed       Append-only log of
  captured as            sessions, extracts        every concept-touching
  replayable skills.     trajectories that are     mutation. X25519 +
  Step-level FTS +       worth keeping. Drops      XChaCha20-Poly1305
  drift caveats on       low-signal noise on       sealed envelopes —
  replay.                the floor.                relay sees ciphertext.
```

---

## What it looks like in practice

```bash
lumen init
lumen add https://karpathy.github.io/2021/06/21/blockchain/
lumen add ./papers/attention-is-all-you-need.pdf
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY
lumen add 1706.03762                                      # arXiv ID
lumen add ./saved-articles/                               # whole folder at once
lumen add https://github.com/anthropics/claude-code       # whole repo
lumen add ./benchmarks/results.csv                        # dataset — schema + preview indexed
lumen add ./screenshots/grafana-dashboard.png             # image — OCR'd into searchable text
lumen watch add obsidian ~/ObsidianVault                  # auto-pull clippings via frontmatter
lumen compile -c 3                                        # extract concepts + build graph (3 parallel)
```

Now search it:

```bash
lumen search "agent orchestration patterns" -b 4000
```

```
1. [8.2] Building Effective AI Agents > Combining and customizing these patterns
   ## Combining and customizing these patterns
   signals: bm25:12% tfidf:146%

2. [7.9] LLM Powered Autonomous Agents > Agent System Overview
   ## Agent System Overview
   signals: tfidf:68%

3. [7.8] Building LLM applications for production > Testing an agent
   #### Testing an agent
   signals: tfidf:68%
```

Or ask a question and get a streamed answer:

```bash
lumen ask "How do agent swarms compare to RAG for knowledge retrieval?"
```

Claude reads the relevant chunks from your corpus and streams the answer token by token — not from training data, from what you've actually read.

---

## Install

```bash
npm install -g lumen-kb
```

Or from source:

```bash
git clone https://github.com/Sardor-M/Lumen.git
cd lumen && pnpm install && pnpm build
cd apps/cli && npm link
```

Set your API key once:

```bash
mkdir -p ~/.lumen
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lumen/.env
```

Lumen always reads `~/.lumen/.env` for API keys, regardless of which workspace you're using. Supports Anthropic (Claude), OpenRouter (multi-model), and Ollama (local). Default model: `claude-sonnet-4-6`.

---

## Wire it into your AI assistant

### Claude Code

```bash
lumen install claude
```

This generates five files:

- **`CLAUDE.md`** — brain-first protocol (mandatory, loaded every message). Tells Claude: check the knowledge base before answering, cite sources as `[Source: title]`, only use web search after the brain returns nothing.
- **`.mcp.json`** — MCP server config with `LUMEN_DIR` baked in so the server always connects to the right workspace.
- **`.claude/skills/lumen/skill.md`** — supplementary skill with tool routing table, capture protocol, and session summary instructions.
- **`.claude/hooks/lumen-pretool.sh`** — PreToolUse hook. Fires before every `Glob` / `Grep` and reminds Claude that MCP search tools exist.
- **`.claude/hooks/lumen-signal.sh`** — Stop hook. Fires after every response and nudges Claude to call `capture` if new knowledge appeared.

After installing, every conversation draws from and adds to your knowledge base automatically.

### MCP server (Cursor, Codex, any MCP client)

```bash
lumen --mcp          # stdio server, 23 tools
```

Add to your client's MCP config:

```json
{
    "mcpServers": {
        "lumen": { "command": "lumen", "args": ["--mcp"] }
    }
}
```

### Cursor / Aider / Copilot (no MCP)

Add this to your instruction file (`.cursorrules`, `CLAUDE.md`, etc.):

```
Before answering research questions, run:
  ! lumen search "<question>" -b 8000
Use the returned chunks as primary context.
```

---

## The agent loop

```
User sends a message
        |
        v
CLAUDE.md fires: "check brain BEFORE answering"
        |
        v
Agent calls brain_ops(query) via MCP
        |
        +-- concept found  --> compiled truth + edges as context
        +-- path found     --> concept connection chain as context
        +-- neighborhood   --> related cluster as context
        +-- search results --> top ranked chunks as context
        |
        v
Agent answers using KB context, cites [Source: title]
        |
        v
Stop hook fires: "call capture if new knowledge appeared"
        |
        v
Agent calls capture(type, title, content, related_slugs)  (PII-scrubbed before write)
        |
        v
Concept upserted + timeline entry + backlinks  OR  folded into existing canonical via alias
        |
        v
Brain is richer for the next conversation
```

Every cycle adds knowledge. The agent enriches concepts after conversations. Next time the same topic comes up, `brain_ops` finds it. The difference compounds daily.

---

## How the brain compounds over time

### Tiered enrichment

Every concept starts at Tier 3 — a stub. As you add more sources that reference it, the tier climbs:

- **Tier 3** — mentioned once. Stub with basic summary.
- **Tier 2** — mentioned 3+ times across 2+ sources. Enriched with connections and context.
- **Tier 1** — mentioned 6+ times across 3+ sources. Full compiled truth — the system's current best understanding of this concept, synthesized from everything you've read.

Run `lumen enrich` to process the queue, or `lumen enrich --status` to see where things stand.

### Skill scoring + retirement

Concepts also accumulate `+1` / `-1` feedback votes (via the `brain_feedback` MCP tool). When the cumulative score crosses `-3`, the concept is auto-retired — soft-deleted, hidden from `brain_ops` search, but still queryable for history. The most recent negative reason becomes the retire reason. Explicit retirement via `retire_skill(slug, reason)` works the same way.

### Merge near-duplicates on write

If you capture `add-route` today and `add-routes` next week with similar content, Lumen folds them into one canonical concept on write. The incoming slug is recorded as an **alias** in the `concept_aliases` table; future lookups for either slug resolve to the canonical row. `brain_ops` returns one consolidated skill instead of N near-duplicates, and feedback votes accumulate on the canonical instead of splitting across siblings.

The merge gate requires **all three**: slug similarity ≥ 0.7 (Levenshtein-normalized), content Jaccard ≥ 0.6 across distinct ≥3-char tokens, and ≥ 4 distinct tokens on both sides (the thin-content guard keeps placeholders from accidentally merging).

### Trajectory capture + replay

When the agent successfully completes a multi-step task — adding a new MCP tool, fixing a typecheck error, ingesting a new format — the literal sequence of `read` / `edit` / `bash` calls plus what each one returned can be stored as a **trajectory** via `capture_trajectory`. Future agents working on similar tasks in the same codebase call `replay_skill(task)` and get the recipe back as a hint, with drift caveats (codebase revision diff, missing file refs, failure outcomes) so the agent knows what's changed since the recipe was captured.

### Trajectory review pass

After a session ends, `lumen review` walks the session's tool-call log, runs an LLM extractor over multi-step successful chains, and writes the high-signal ones as trajectories. Per-session outcomes (`extracted` / `skipped` / `failed`) land in `session_review` so the same session is never re-extracted. Low-value churn never reaches the graph — only chains that crossed the minimum-step threshold and looked coherent to the extractor get stored. Run on demand or as part of a daemon sweep.

### Skill-first `brain_ops`

The brain's main entry point doesn't just return search results — it returns a **skill-first response shape**: matching trajectories surfaced ahead of free-form chunks, with a per-call token budget hint so the agent can decide whether it has enough context or needs to widen the search. Every `brain_ops` call also writes an exploration-cost row to `query_log` (tokens spent, skill-hit yes/no, latency), so `lumen profile` can show which intents are paying off and which are wasting budget.

### Scope-aware everything

Every source, concept, and trajectory carries a `(scope_kind, scope_key)` pair — `codebase` (git remote SHA1 / fingerprint / local-path), `framework` (next, fastapi, react, …), `language` (ts, py, rust, …), `personal`, or `team`. Retrieval is scope-filtered by default, so work on repo A doesn't pollute results in repo B. Codebase identity collapses cleanly: SSH and HTTPS clones of the same repo produce the same scope key.

### Capture / session summary protocol

The `capture` MCP tool writes the conversation → graph direction. When the assistant is discussing something worth remembering, it calls `capture` with the exact phrasing. `session_summary` closes out a session with a digest of what was covered. **Both run through the PII gate** — emails, API tokens (Anthropic, OpenAI, GitHub, Slack, AWS, GCP), JWTs, Luhn-validated credit cards, phone numbers, private IPv4, and home paths are redacted with stable replacement tokens before any database write.

### Cross-device sync foundation

Every concept-touching mutation — `upsertConcept`, `recordFeedback`, `updateCompiledTruth`, `retireConcept`, `captureTrajectory` — atomically appends a row to an append-only `sync_journal` inside the same SQLite transaction as the entity write. A crash mid-write rolls both back. Each journal row carries an `(op, entity_id, scope, payload, device_id)` tuple plus a UUIDv7-shape sortable id (12 hex unix-ms + 4 hex monotonic counter + 16 hex random). When opt-in sync is enabled, payloads are sealed with X25519 + XChaCha20-Poly1305 (24-byte nonce, fresh ephemeral keypair per envelope) before they leave the device. Domain-separated key derivations: relay routing key, per-scope routing tag, key fingerprint — all derived from a single 32-byte master key the relay never sees. The pipeline ships in tiers: the local journal, crypto envelope, and HTTP push/pull driver are wired into `lumen sync init/enable/push/pull/run/status` (Tier 5a–5c, all merged); the reference Cloudflare Worker relay (Hono + D1, deployable with `wrangler d1 create && wrangler deploy`) lives at `apps/relay/` (Tier 5d). Per-op apply rules — translating pulled entries into local store mutations on the destination device — are the last tier still in flight (Tier 5e).

---

## How it works

**Ingestion** — no LLM needed. URL scraping via `@extractus/article-extractor`, PDF via `pdf-parse`, YouTube transcripts via the Innertube captions API, arXiv via Atom + PDF. Code repos via shallow `git clone` with `.gitignore`-aware walk and per-language signature extraction. Datasets (CSV, TSV, JSONL, HuggingFace) produce a schema table plus a 20-row preview. Images use optional local Tesseract OCR when the binary is on PATH (`--no-ocr` skips). Obsidian Web Clipper vaults are watched as a connector — YAML frontmatter promotes the original URL so re-clippings dedup. SHA-256 deduplication throughout, so the same quote across five sources costs one row.

**Compilation** — LLM pass. Extracts concepts and relations from stored chunks, writes them as nodes and weighted directed edges with compiled truth + timeline per concept. Delta-aware: `compile` only touches unprocessed sources. `compile --all` reprocesses everything. `compile -c 5` runs 5 sources in parallel. `compile --model claude-haiku-4-5-20251001` uses a faster/cheaper model.

**Search** — local, no LLM. BM25 via SQLite FTS5 (Porter stemmed), TF-IDF via in-memory inverted index (cosine similarity), optional vector ANN via sqlite-vec (OpenAI or Ollama embeddings, 1536-dim). Fused with Reciprocal Rank Fusion (`score = Σ weight / (k + rank)`, k=60), ranked by relevance density so small high-value chunks beat verbose low-value ones. Intent routing in `brain_ops` short-circuits common cases (concept lookup, graph path, neighborhood) before falling through to the full hybrid pipeline.

**Synthesis** — LLM pass with prompt caching (`cache_control: ephemeral`, ~60-80% cost reduction on repeated calls within a session). `lumen ask` streams tokens to stdout as they arrive. Non-Anthropic providers fall back gracefully.

---

## CLI reference

| Command                | What it does                                                             | LLM |
| ---------------------- | ------------------------------------------------------------------------ | --- |
| `init`                 | Create `~/.lumen` workspace                                              |     |
| `add <input>`          | Ingest URL, PDF, YouTube, arXiv, file, folder, code repo, dataset, image |     |
| `compile`              | Extract concepts + edges from unprocessed sources                        | yes |
| `enrich`               | Tier-score concepts and LLM-enrich queued ones                           | yes |
| `embed`                | Generate vector embeddings for chunks                                    | API |
| `search <query>`       | Hybrid local search (BM25 + TF-IDF + vector + graph)                     |     |
| `ask <question>`       | Search + streamed LLM-synthesized answer                                 | yes |
| `graph <subcommand>`   | Overview, pagerank, path, neighbors, communities, report, export         |     |
| `review`               | LLM extracts trajectories from completed sessions                        | yes |
| `profile`              | Corpus summary — sources, density, frequent queries                      |     |
| `status`               | DB statistics (text or JSON)                                             |     |
| `memory export/import` | Portable JSONL or SQL backup                                             |     |
| `serve`                | Start the web UI against your local knowledge base                       |     |
| `install <platform>`   | Wire into Claude Code (`claude`) or Codex (`codex`)                      |     |
| `watch`                | Manage auto-ingest connectors (folder, rss, arxiv, github, obsidian, …)  |     |
| `sync <subcommand>`    | E2E-encrypted cross-device sync — init, enable, push, pull, run, status  |     |
| `daemon`               | Install/uninstall as background launchd/systemd service                  |     |

Compile options: `lumen compile -c 5` (5 parallel), `lumen compile --model claude-haiku-4-5-20251001` (faster model), `lumen compile --all` (reprocess everything).

Add options: `--type <type>` force source type; `--as-dataset` treat an ambiguous text file as tabular data; `--no-ocr` skip OCR when ingesting images; `--from <file>` read inputs line-by-line.

Search options: `lumen search "query" -n 5` (limit results), `lumen search "query" -b 4000` (token budget), `--bm25-only`.

Graph subcommands: `lumen graph status`, `lumen graph pagerank`, `lumen graph path <a> <b>`, `lumen graph neighbors <concept> -d 2`, `lumen graph communities`, `lumen graph report`, `lumen graph export -f json` (or `dot`).

Watch subcommands: `lumen watch add <type> <target>`, `lumen watch list`, `lumen watch get <id>`, `lumen watch remove <id>`, `lumen watch pull <id>`, `lumen watch run`, `lumen watch daemon`.

Sync subcommands: `lumen sync init [--relay <url>]`, `lumen sync enable`/`disable`, `lumen sync push`/`pull`/`run`, `lumen sync status`, `lumen sync reset-error`, `lumen sync show-key [--reveal]`, `lumen sync import-key <base64>`, `lumen sync forget-key`. The relay is opt-in — sync only runs once a master key is generated (or imported) and `enable` is called. Self-host the reference Worker relay at `apps/relay/` or point at any conformant HTTP endpoint.

---

## MCP tools (23 total)

```bash
lumen --mcp    # stdio server
```

| Group                  | Tools                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| **Brain entry point**  | `brain_ops` (intent-routed, skill-first response with budget hint)       |
| **Search & retrieval** | `search`, `query`                                                        |
| **Concept**            | `concept`, `add_link`, `links`, `backlinks`                              |
| **Graph**              | `god_nodes`, `pagerank`, `path`, `neighbors`, `communities`, `community` |
| **Write**              | `add`, `compile`, `capture`, `session_summary`                           |
| **Skill scoring**      | `brain_feedback`, `retire_skill`                                         |
| **Trajectory**         | `capture_trajectory`, `replay_skill`                                     |
| **Meta**               | `status`, `profile`                                                      |

`brain_ops` auto-detects intent from the query shape (concept lookup / graph path / neighborhood / hybrid search), surfaces matching trajectories ahead of free-form chunks, and returns a per-call token-budget hint so the agent can decide whether to widen the search. Every call writes an exploration-cost row to `query_log` (tokens spent, skill-hit, latency) so `lumen profile` can show which intents are paying off. Agents should call this first; everything else is for cases where the agent already knows the specific operation it needs.

---

## Library API

```ts
import { createLumen } from 'lumen-kb';

const lumen = createLumen({ dataDir: '~/.lumen' });
const results = lumen.search({ query: 'attention mechanism', limit: 10 });
const answer = await lumen.ask({ question: 'How does self-attention work?' });
lumen.close();
```

Returns a frozen handle with these surfaces:

- **Top-level methods** — `add`, `search`, `ask`, `compile`, `status`, `profile`, `dataDir`, `close`
- **`graph` namespace** — `godNodes`, `pagerank`, `neighbors`, `path`, `communities`, `components`, `toJson`, `toDot`, `report`
- **`watch` namespace** — `add`, `list`, `get`, `remove`, `pull`, `run`, `runDue`, `handlerTypes`
- **`sources` namespace** — `get`, `list`, `count`, `countByType`
- **`concepts` namespace** — `get`, `list`, `count`
- **`chunks` namespace** — `get`, `list`, `count`

All methods accept an optional `onCall` observability hook for tracing — zero cost when omitted.

---

## Framework adapters

For agents that don't speak MCP, Lumen ships native adapters under `lumen-kb/<adapter>`:

```ts
// OpenAI function calling
import { openaiTools, handleOpenAIToolCall } from 'lumen-kb/openai';

// Vercel AI SDK
import { withLumen } from 'lumen-kb/ai-sdk';
const { system, tools } = withLumen(lumen, { mode: 'profile+search' });

// LangChain
import { createLumenTools } from 'lumen-kb/langchain';

// Mastra
import { createMastraTools } from 'lumen-kb/mastra';
```

All four wrap the same provider-agnostic `tools.ts` surface, so the canonical tool definitions live in one place and the adapters are thin envelopes — no vendor lock-in.

---

## Repo layout

Monorepo — Turborepo + pnpm workspaces.

```
lumen/
├── apps/
│   ├── cli/         — CLI and MCP server (the engine, published as lumen-kb)
│   ├── web/         — Next.js 15 web UI (Better Auth, Zod, shadcn)
│   ├── landing/     — Marketing site (Next.js 15)
│   ├── relay/       — Reference Cloudflare Worker (Hono + D1) for E2E-encrypted sync
│   └── extension/   — Browser extension (placeholder)
├── docs/            — ALGORITHMS.md, architecture, test plans, design memos
├── test-benchmarks/ — Side-by-side Mode 1 (bare) vs Mode 2 (agent wired)
├── benchmarks/      — Ingest / search / graph / mcp benchmark runners
├── packages/
│   ├── ui/          — Shared UI primitives
│   ├── brand/       — Shared logo / colors
│   ├── tsconfig/    — Shared TS configs
│   └── eslint-config/
├── turbo.json
└── pnpm-workspace.yaml
```

---

## Web UI

`lumen serve` starts a Next.js 15 app that reads directly from `~/.lumen/lumen.db`. No separate server, no duplicate query code.

Pages: overview (sources / concepts / edges / density / pending), hybrid search with per-signal score breakdown, concept browser, concept detail (neighborhood, edges, timeline, score), sources list, and graph dashboard (god nodes, communities, top concepts).

```bash
lumen serve                          # dev mode, http://localhost:3000
lumen serve --port 4000 --mode prod  # after pnpm build in apps/web
```

---

## Storage

Everything in `~/.lumen/`:

```
~/.lumen/
├── lumen.db          # SQLite WAL — sources, chunks, FTS5 + sqlite-vec, concepts,
│                     #   edges, links, embeddings, feedback, aliases, scopes,
│                     #   trajectories (as sources), classifiers, query_log
├── config.json       # User config (LLM model, embedding provider, search weights)
├── .env              # API keys (always checked, even if LUMEN_DIR is set elsewhere)
├── audit.log         # Append-only JSON-lines operation log
└── output/           # Generated exports and reports
```

One file. Back it up and you have everything.

### Schema versions

Schema is at **v15**. Migrations are additive and applied automatically on first DB open:

- v5 — vector embeddings
- v6 — compiled truth + timeline
- v7 — link management (concept_links)
- v8 — self-improving classifiers (pattern + fallback tables)
- v9 — tiered enrichment
- v10 — scope dimension (scope_kind, scope_key on sources + concepts; scopes registry)
- v11 — concept scoring + retirement (score, retired_at, retire_reason; concept_feedback log)
- v12 — concept aliases (merge near-duplicates on write)
- v13 — exploration-cost telemetry on `query_log` (tokens_spent, skill_hit, latency)
- v14 — trajectory review pass (`session_review` outcomes per session)
- v15 — sync foundation (`sync_state` singleton + append-only `sync_journal`)

---

## Algorithms

| Algorithm                 | Use                          | Reference                            |
| ------------------------- | ---------------------------- | ------------------------------------ |
| BM25                      | Full-text ranking            | Robertson & Zaragoza, 2009           |
| TF-IDF                    | Vector similarity            | Salton & Buckley, 1988               |
| Reciprocal Rank Fusion    | Multi-signal merging         | Cormack, Clarke & Butt, 2009         |
| PageRank                  | Concept importance           | Page, Brin, Motwani & Winograd, 1998 |
| Label Propagation         | Community detection          | Raghavan, Albert & Kumara, 2007      |
| Jaccard Similarity        | Near-duplicate detection     | Jaccard, 1901                        |
| Levenshtein Distance      | Slug similarity              | Levenshtein, 1966                    |
| Luhn Checksum             | Credit-card validation (PII) | Luhn, 1960                           |
| Content-Addressed Storage | Source deduplication         | Quinlan & Dorward, 2002              |
| Extractive Summarization  | Compression                  | Luhn, 1958                           |

Details in [docs/ALGORITHMS.md](./docs/ALGORITHMS.md).

---

## Tech stack

```
Runtime:     Node.js 22+
Language:    TypeScript 5
Storage:     better-sqlite3 (WAL, FTS5)
Vectors:     sqlite-vec (ANN search, cosine similarity, 1536-dim)
LLM:         @anthropic-ai/sdk (+ OpenRouter, Ollama)
Embeddings:  OpenAI text-embedding-3-small / Ollama nomic-embed-text
PDF:         pdf-parse
URL:         @extractus/article-extractor
YouTube:     Innertube captions API
arXiv:       Atom API + PDF extraction
OCR:         Tesseract (optional, system binary)
CLI:         Commander.js
MCP:         @modelcontextprotocol/sdk (23 tools)
Web:         Next.js 15, Better Auth, Zod, shadcn/ui, Tailwind
Monorepo:    Turborepo + pnpm 10 workspaces
```

---

## Privacy

The only network calls are: (a) fetching the URL, paper, video, or repo you asked to ingest, (b) model API calls during `compile`, `enrich`, and `ask` using your own API key, and (c) embedding API calls during `embed` if configured.

No telemetry. No analytics. Search, graph traversal, compression, chunking, deduplication, near-duplicate merging, alias resolution, scope detection, and PII scrubbing all run locally against the SQLite file.

The PII gate runs deterministic regex over every agent-originated capture before it hits the database — emails, API tokens, JWTs, Luhn-validated credit cards, phone numbers, private IPv4, and home directory paths are redacted with stable replacement tokens. Strict mode (opt-in) rejects any capture that contains a redacted pattern instead of scrubbing it.

---

## Development

```bash
pnpm install
pnpm dev                          # turbo dev — all apps in parallel
pnpm --filter lumen-kb dev        # CLI only
pnpm --filter @lumen/web dev      # web only
pnpm build
pnpm lint && pnpm format:check    # pre-commit check
pnpm test                         # vitest
```

Tests use a temp directory: `LUMEN_DIR=$(mktemp -d)`. The CLI workspace has **784+ tests** covering ingest, chunker, search, graph, store CRUD, scope resolver, scoring, dedup, trajectory capture/replay, trajectory review pass, PII scrubber, MCP server contract, framework adapters, query telemetry, sync journal, and the encryption envelope.

---

## Contributing

Open an issue before large changes. High-value areas:

- Additional ingest formats (EPUB, DOCX, Parquet native)
- Tree-sitter-based code parsing to replace the current regex signatures
- Claude Vision pass on compile for image captions
- In-house browser clipper extension (deferred until Obsidian flow is validated)
- Web dashboard — live graph visualization
- Mastra and LangChain adapter improvements
- Per-op apply rules / LWW conflict resolution (Tier 5e) — translates pulled journal entries into local store mutations; the last piece needed for end-to-end multi-device sync now that the journal (5a), crypto envelope (5b), HTTP push/pull driver (5c), and reference Cloudflare Worker relay (5d) have shipped

---

## Links

- [npm package](https://www.npmjs.com/package/lumen-kb)
- [GitHub](https://github.com/Sardor-M/Lumen)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Benchmark plan](./docs/BENCHMARK-PLAN.md)

## License

[MIT](./LICENSE.md)
