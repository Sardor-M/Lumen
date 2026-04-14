# Lumen

**Local-first knowledge compiler** — ingest articles, papers, PDFs, and YouTube transcripts into a structured knowledge graph. Search, graph traversal, and profile generation run entirely offline. Only compilation and Q&A synthesis use an LLM.

<!-- badges -->
<!-- [![npm](https://img.shields.io/npm/v/lumen-kb)](https://www.npmjs.com/package/lumen-kb) -->
<!-- [![License](https://img.shields.io/badge/license-PolyForm--Shield--1.0.0-blue)](./LICENSE.md) -->
<!-- [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org) -->

Drop URLs, PDFs, YouTube links, arXiv IDs, or local files into Lumen — it extracts, chunks, deduplicates, and stores everything in a single SQLite database. Search uses a 3-signal hybrid retriever (BM25 + TF-IDF + graph walk) fused via Reciprocal Rank Fusion. Compilation turns chunks into concepts and weighted edges via LLM. Every run writes to `~/.lumen/`, and nothing leaves your machine except the extraction calls to the model API you configured.

## Repo layout

Monorepo — Turborepo + pnpm workspaces.

```
lumen/
├── apps/
│   ├── cli/         — CLI and MCP server (the engine)
│   ├── web/         — Next.js 15 web UI (Better Auth, Zod, shadcn)
│   └── extension/   — Browser extension (placeholder)
├── .claude/skills/  — 9 Claude Code skills for working in this repo
├── docs/            — ALGORITHMS.md, REFERENCE.md, roadmap
├── turbo.json
└── pnpm-workspace.yaml
```

## Install

```bash
pnpm install
pnpm --filter @lumen/cli build
npm link                         # from apps/cli/ — makes `lumen` global
```

npm package coming soon.

## Quick Start

```bash
lumen init                                          # create ~/.lumen workspace
lumen add https://karpathy.github.io/2021/06/21/blockchain/   # ingest a URL
lumen add ./papers/attention.pdf                     # ingest a PDF
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY  # ingest YouTube transcript
lumen add 1706.03762                                 # ingest arXiv paper
lumen add ./saved-articles/                          # ingest a folder
lumen compile                                        # LLM-compile into concepts + edges
lumen search "agent orchestration patterns"          # hybrid local search
lumen ask "How do agent swarms compare to RAG?"      # LLM-synthesized answer
lumen profile                                        # corpus overview — sources, density, recent
```

### API key

Lumen reads `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`) from:

1. `~/.lumen/.env` — persistent, works from any directory
2. `$PWD/.env` — dev override
3. Shell environment

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lumen/.env
```

## Architecture

Lumen is a **knowledge compiler**, not an LLM wrapper. The LLM is one component (the synthesizer and the concept/edge extractor) — search, indexing, chunking, compression, and graph traversal all run locally.

```
    INGEST              CHUNK               STORE              SEARCH
    ──────              ─────               ─────              ──────

  URL     ─┐          ┌─ Markdown         ┌─ Sources         ┌─ BM25 (FTS5)
  PDF     ─┤          │                   │                  │
  YouTube ─┼─ Extract ┼─ HTML        ──►  ├─ Chunks    ──►   ├─ TF-IDF (inverted index)
  arXiv   ─┤          │                   │                  │
  File    ─┤          └─ Plain text       ├─ Chunks_FTS      └─ Graph walk
  Dir     ─┘                              ├─ Concepts              │
                                          └─ Edges                 ▼
                                                            RRF Fusion
                                                                │
    COMPRESS            SYNTHESIZE          GRAPH                ▼
    ────────            ──────────          ─────           Budget cut
                                                                │
  1. Structural ──►  LLM (Claude /      PageRank                ▼
  2. Boilerplate     OpenRouter /        Path finding      Ranked chunks
  3. Extractive      Ollama)             Clustering             │
  4. Dedup                               Visualization          ▼
                          │                                LLM synthesis
                          ▼                                (only if needed)
                    Concepts + edges
                    + knowledge graph
```

### Two Pipelines

**Ingestion** (offline — no LLM needed):

1. **Extract** — URL scraping via `@extractus/article-extractor`, PDF parsing via `pdf-parse`, YouTube transcripts via the Innertube captions API, arXiv via Atom + PDF extraction, filesystem for local files and folders.
2. **Chunk** — Markdown-aware structural splitting (headings, paragraphs, code blocks, lists as atomic units). HTML and plain-text chunkers included.
3. **Dedup** — SHA-256 over whitespace-normalized content eliminates duplicate chunks across sources.
4. **Store** — SQLite WAL mode with FTS5 full-text index.
5. **Index** — TF-IDF vocabulary build, corpus-level IDF computation.

**Compilation** turns stored chunks into a knowledge graph via LLM. The compiler extracts concepts and relations and stores them as nodes and weighted directed edges. Delta-aware: `compile` only processes unprocessed sources; `compile --all` forces re-extraction.

**Retrieval** (search is local, synthesis uses LLM):

1. **BM25** via SQLite FTS5 — stemmed full-text matching, scores normalized to `[0,1]`.
2. **TF-IDF** via inverted index — cosine similarity between query and chunk vectors.
3. **Graph walk** — find matching concepts, traverse 1-2 hops on the knowledge graph, inject context.
4. **RRF Fusion** — `score(d) = Σ (weight / (k + rank(d)))` with k=60.
5. **Budget cut** — greedy selection by `relevance_density = score / token_count`.
6. **Compression** — 4-stage pipeline (structural preservation → boilerplate collapse → extractive scoring → Jaccard dedup).
7. **LLM synthesis** — selected chunks sent to Claude/OpenRouter/Ollama for the final answer.

## CLI

| Command                | Purpose                                             | Needs LLM |
| ---------------------- | --------------------------------------------------- | --------- |
| `init`                 | Create `~/.lumen` workspace                         | No        |
| `add <input>`          | Ingest URL, PDF, YouTube, arXiv, file, or folder    | No        |
| `compile`              | Extract concepts and edges from unprocessed sources | **Yes**   |
| `search <query>`       | Hybrid local search (BM25 + TF-IDF + graph)         | No        |
| `ask <question>`       | Search + LLM-synthesized answer                     | **Yes**   |
| `graph <subcommand>`   | Overview, pagerank, path, neighbors, report, export | No        |
| `profile`              | Corpus profile — sources, density, frequent queries | No        |
| `memory export/import` | Portable knowledge base backup (JSONL or SQL)       | No        |
| `serve`                | Start the web UI against your local knowledge base  | No        |
| `status`               | Data directory and DB statistics                    | No        |
| `install <platform>`   | Set up AI assistant integration (claude, codex)     | No        |

Graph subcommands: `lumen graph` (overview), `lumen graph pagerank`, `lumen graph path <a> <b>`, `lumen graph neighbors <concept> -d 2`, `lumen graph report` (writes `GRAPH_REPORT.md`), `lumen graph export -f json`.

Planned: `config`, `delta`, `digest`, `export`, `lint`, `benchmark` — stubs exist, not yet wired.

## Features

### Hybrid 3-signal search

BM25 (stemmed FTS5), TF-IDF (inverted index with corpus IDF), and knowledge graph walk, fused via Reciprocal Rank Fusion (`score = Σ weight / (k + rank)`, k=60). Ranked by `relevance_density`, so small high-value chunks surface ahead of verbose low-value ones.

### Structural document chunking

Markdown-aware splitter — headings, paragraphs, code blocks, lists as atomic units. Merges fragments under 50 tokens; splits chunks over 1000 tokens at sentence boundaries. HTML and plain-text chunkers included.

### 4-stage compression pipeline

1. **Structural preservation** — lock headings, first paragraphs, code blocks, key definitions
2. **Boilerplate collapse** — long lists become `[N items: first, second, ...]`
3. **Extractive scoring** — TF-IDF per-sentence importance, prune lowest
4. **Near-duplicate removal** — Jaccard similarity > 0.8 eliminates redundant sentences

### Knowledge graph engine

Concepts as nodes, relations as weighted directed edges. PageRank for hub identification, BFS for shortest paths between any two concepts, label propagation for community detection. Export as JSON (D3.js / graph tools) or DOT (Graphviz).

### Content-addressed deduplication

SHA-256 over whitespace-normalized content. Identical chunks across different sources stored once. Deduplication happens at ingest, so the same quote in five sources costs one row.

### Profile with caching

`lumen profile` summarizes the corpus — source count, concept/edge counts, graph density, pending compilation, recent sources, and frequent queries from the query log. Result is cached and invalidated on write.

### Query log memory layer

Every `search` and `ask` is logged. `lumen profile` surfaces frequently asked questions. `lumen memory export <file>` writes a portable JSONL or SQL dump of sources, chunks, concepts, edges, and the query log. `lumen memory import` replaces (default) or merges into an existing workspace.

### MCP server

`lumen --mcp` starts an MCP stdio server exposing 12 tools to any MCP client (Claude Code, Cursor, Codex, etc.):

`status`, `search`, `query`, `add`, `profile`, `god_nodes`, `concept`, `path`, `neighbors`, `pagerank`, `communities`, `community`.

Assistants that speak MCP can search, traverse, and ingest directly without shelling out.

### Claude Code skill

`lumen install claude` drops a skill file at `.claude/skills/lumen/SKILL.md` and installs a `PreToolUse` hook that fires before every `Glob` / `Grep` call. If a compiled knowledge base exists, the hook surfaces concept/edge counts and nudges Claude to use the MCP tools instead of grepping through raw files.

The repo itself ships 9 Claude Code skills for contributors: `code-review`, `debug-lumen`, `deploy-check`, `lumen-mcp`, `monorepo-guide`, `new-command`, `new-module`, `verify`, `web-page`.

### Web UI

`apps/web` is a Next.js 15 app (Better Auth, Zod, shadcn/ui) that reads directly from your local `~/.lumen/lumen.db` through the CLI's store layer — no duplicate query code, no separate server.

Pages wired to live data: overview (sources / concepts / edges / density / pending), hybrid search with per-signal score breakdown, concept browser with mention counts, concept detail (neighborhood, outgoing/incoming edges), sources list, and graph dashboard (god nodes, communities, top concepts). API routes at `/api/{status,search,graph,concepts,concepts/[slug],sources,profile}`.

Launch from any directory — `serve` forwards `LUMEN_DIR` so the web app reads the same SQLite file the CLI does:

```bash
lumen serve                          # dev mode, http://localhost:3000
lumen serve --port 4000 --mode prod  # after running `pnpm build` in apps/web
```

Or run Next.js directly:

```bash
pnpm --filter @lumen/web dev
```

### Profile latency

`lumen profile` is cached in SQLite and invalidated on writes. A test in `apps/cli/tests/profile.test.ts` asserts a cached median read under 50ms on a 50-source / 100-concept / 200-edge corpus.

## Storage

Everything lives in `~/.lumen/`:

```
~/.lumen/
├── lumen.db          # SQLite WAL — sources, chunks, FTS5, concepts, edges, query_log
├── config.json       # User configuration
├── .env              # API keys (optional)
├── audit.log         # Append-only JSON-lines operation log
└── output/           # Generated exports
```

One SQLite file. No vector store, no cloud sync, no server process. Back up `~/.lumen/` and you have everything.

## AI Integration

### Claude Code

```bash
lumen install claude
```

Writes `.claude/skills/lumen/SKILL.md` + a `PreToolUse` hook in `.claude/settings.json`. Type `/lumen` in Claude Code to query the knowledge base through MCP.

### Cursor / Aider / Copilot

Add to your instruction file (`.cursorrules`, `CLAUDE.md`, etc.):

```
Before answering research questions, run:
  ! lumen search "<question>" --budget 8000
Use the returned chunks as primary context.
```

### Programmatic (Node.js)

```typescript
import { getDb } from '@lumen/cli/store/db.js';
import { search } from '@lumen/cli/search/index.js';
import { graph } from '@lumen/cli/graph/index.js';

const results = await search('agent orchestration', { budget: 4000 });
const path = graph.shortestPath('agent-swarm', 'single-agent');
const hubs = graph.pagerank({ top: 10 });
```

## Configuration

API key lookup order: `~/.lumen/config.json` → `~/.lumen/.env` → `$PWD/.env` → shell environment.

```bash
# ~/.lumen/.env
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENROUTER_API_KEY=sk-or-...
```

Supported providers: **Anthropic** (Claude), **OpenRouter** (multi-model), **Ollama** (local).

## Algorithms

Every core algorithm is implemented from scratch, documented with academic references.

| Algorithm                 | Use                 | Reference                            |
| ------------------------- | ------------------- | ------------------------------------ |
| BM25                      | Full-text ranking   | Robertson & Zaragoza, 2009           |
| TF-IDF                    | Vector similarity   | Salton & Buckley, 1988               |
| Reciprocal Rank Fusion    | Signal merging      | Cormack, Clarke & Butt, 2009         |
| PageRank                  | Concept importance  | Page, Brin, Motwani & Winograd, 1998 |
| Content-Addressed Storage | Deduplication       | Quinlan & Dorward, 2002              |
| Extractive Summarization  | Compression         | Luhn, 1958                           |
| Label Propagation         | Community detection | Raghavan, Albert & Kumara, 2007      |

Details in [docs/ALGORITHMS.md](./docs/ALGORITHMS.md).

## Tech Stack

```
Runtime:     Node.js 22+
Language:    TypeScript 5
Storage:     better-sqlite3 (WAL, FTS5)
LLM:         @anthropic-ai/sdk (+ OpenRouter, Ollama)
PDF:         pdf-parse
URL:         @extractus/article-extractor
YouTube:     Innertube captions API
arXiv:       Atom API + PDF extraction
CLI:         Commander.js
MCP:         @modelcontextprotocol/sdk
Web:         Next.js 15, Better Auth, Zod, shadcn/ui, Tailwind
Monorepo:    Turborepo + pnpm workspaces
```

## Privacy

The only network calls are (a) extraction fetches from the URL or arXiv you asked for, and (b) model API calls during `compile` / `ask` using your own API key. No telemetry. No analytics. Everything else — search, graph traversal, profile, chunking, dedup, compression — runs locally over the SQLite file.

## Development

```bash
pnpm install
pnpm dev                          # turbo dev — all apps in parallel
pnpm --filter @lumen/cli dev      # CLI only
pnpm --filter @lumen/web dev      # web only
pnpm build                        # turbo build
pnpm lint && pnpm format:check    # pre-commit check
pnpm test                         # vitest
```

## Contributing

Contributions welcome. Open an issue before large changes. High-value areas:

- Wire the stub commands (`config`, `delta`, `digest`, `export`, `lint`, `benchmark`, `serve`)
- Additional ingest formats (EPUB, DOCX, RSS)
- Additional chunker formats (RST, LaTeX)
- Dense embedding signal for hybrid search
- Web dashboard — live graph visualization, corpus browser

## License

Licensed under [PolyForm Shield 1.0.0](./LICENSE.md). Free to use, modify, and distribute for any purpose **except** competing with the licensor's products or services. Commercial licensing: sardor0968@gmail.com.
