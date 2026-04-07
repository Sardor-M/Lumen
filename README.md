# Lumen

**Intelligent knowledge compiler** — ingest, chunk, search, and compile any reading into a structured knowledge graph. Locally.

<!-- badges -->
<!-- [![npm](https://img.shields.io/npm/v/lumen-kb)](https://www.npmjs.com/package/lumen-kb) -->
<!-- [![License](https://img.shields.io/badge/license-PolyForm--Shield--1.0.0-blue)](./LICENSE.md) -->
<!-- [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org) -->

Lumen indexes your articles, papers, and notes into a local SQLite store, chunks every document with structural awareness, scores every chunk with a 3-signal hybrid retriever, compresses results with a 4-stage pipeline, and synthesizes answers through LLM — returning exactly what you need within a token budget. Search, graph traversal, and 8 of 13 commands run entirely offline.

## Install

```bash
npm install -g lumen-kb
```

## Quick Start

```bash
lumen init                                          # create ~/.lumen workspace
lumen add https://stripe.com/blog/minions           # ingest a URL
lumen add ./papers/attention.pdf                     # ingest a PDF
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY  # ingest YouTube transcript
lumen add 2301.12345                                 # ingest arXiv paper
lumen add ./saved-articles/                          # ingest a folder
lumen compile                                       # compile into knowledge graph
lumen search "agent orchestration patterns"          # local search (<50ms)
lumen ask "How do agent swarms compare to RAG?"      # LLM-synthesized answer
```

## Performance

| Metric           | Target                              |
| ---------------- | ----------------------------------- |
| Search latency   | <50ms local, <3s with LLM synthesis |
| Ingest speed     | 100+ articles/sec (chunk + store)   |
| Token reduction  | 50-70% via compression pipeline     |
| Dedup savings    | 10-20% duplicate chunks eliminated  |
| Offline commands | 8/13 work without API key           |
| Storage overhead | ~4 bytes per indexed token          |

## Architecture

Lumen is a **knowledge compiler**, not an LLM wrapper. The LLM is one component (the synthesizer) — search, indexing, chunking, compression, and graph traversal all run locally.

```
    INGEST              CHUNK               STORE              SEARCH
    ──────              ─────               ─────              ──────

  URL     ─┐          ┌─ Markdown         ┌─ Sources         ┌─ BM25 (FTS5)
  PDF     ─┤          │                   │                   │
  YouTube ─┼─ Extract ┼─ HTML        ──►  ├─ Chunks    ──►   ├─ TF-IDF (inverted index)
  arXiv   ─┤          │                   │                   │
  File    ─┤          └─ Plain text       ├─ Chunks_FTS      └─ Graph walk
  Dir     ─┘                                ├─ Concepts              │
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
                    Concept articles
                    + knowledge graph
```

### Two Pipelines

**Ingestion** (offline — no LLM needed):

1. **Extract** — URL scraping, PDF parsing, YouTube transcripts, arXiv papers, file reading
2. **Chunk** — Markdown-aware structural splitting (headings, paragraphs, code blocks, lists)
3. **Dedup** — SHA-256 content addressing eliminates duplicate chunks across sources
4. **Store** — SQLite WAL mode with FTS5 full-text index
5. **Index** — TF-IDF vocabulary build, corpus-level IDF computation

**Retrieval** (search is local, synthesis uses LLM):

1. **BM25** via SQLite FTS5 — stemmed full-text matching, scores normalized to [0,1]
2. **TF-IDF** via inverted index — cosine similarity between query and chunk vectors
3. **Graph walk** — find matching concepts, traverse 1-2 hops on knowledge graph, inject context
4. **RRF Fusion** — `score(d) = Σ (weight / (k + rank(d)))` with k=60
5. **Budget cut** — greedy selection by `relevance_density = score / token_count`
6. **Compression** — 4-stage pipeline reduces token usage 50-70%
7. **LLM synthesis** — selected chunks sent to Claude/GPT/Ollama for final answer

## Features

### Hybrid 3-signal search

BM25, TF-IDF, and knowledge graph walk fused via Reciprocal Rank Fusion. Cost-model ranking scores by value-per-token, not just relevance — large low-value chunks are demoted, small high-value chunks surface first.

### Structural document chunking

Markdown-aware parser splits by headings, preserves code blocks and lists as atomic units, merges tiny fragments (<50 tokens), and splits oversized chunks (>1000 tokens) at sentence boundaries. HTML and plain text chunkers included.

### 4-stage compression pipeline

1. **Structural preservation** — lock headings, first paragraphs, code blocks, key definitions
2. **Boilerplate collapse** — replace long lists with `[N items: first, second, ...]`, collapse repetition
3. **Extractive scoring** — TF-IDF importance scoring per sentence, prune lowest-scoring lines
4. **Near-duplicate removal** — Jaccard similarity (>0.8 threshold) eliminates redundant sentences

### Knowledge graph engine

Concepts as nodes, relations as weighted directed edges. PageRank identifies hub concepts. BFS shortest path finds connections between any two ideas. Label propagation detects concept clusters. Export as DOT (Graphviz) or JSON (D3.js).

### Content-addressed deduplication

SHA-256 hash of whitespace-normalized content. Identical chunks across different sources stored once. Duplicate detection on ingest prevents redundant processing.

### Delta-aware incremental compilation

File-level change detection via mtime + content hash. Chunk-level diff identifies exactly what changed. Only affected concepts are recompiled — article #500 compiles as fast as article #1.

### Offline-first design

8 of 13 commands run with zero API calls. Search, graph traversal, lint (structural), status, delta, benchmark, serve, and config all work offline. LLM is only called for compilation, Q&A synthesis, and export generation.

### Full audit trail

Append-only JSON-lines log of every operation — ingest, compile, search, lint. Provides evidence trail and debugging history.

## CLI

| Command                   | Purpose                                                | Needs LLM |
| ------------------------- | ------------------------------------------------------ | --------- |
| `init`                    | Create `~/.lumen` workspace                            | No        |
| `add <input>`             | Ingest URL, PDF, YouTube, arXiv, file, or folder       | No        |
| `compile`                 | Compile unprocessed chunks into wiki                   | **Yes**   |
| `search <query>`          | Hybrid local search (BM25 + TF-IDF + graph)            | No        |
| `ask <question>`          | Search + LLM-synthesized answer                        | **Yes**   |
| `lint`                    | Wiki health checks (structural: local / semantic: LLM) | Partial   |
| `digest`                  | Summary of recent additions                            | **Yes**   |
| `export <format> <topic>` | Generate slides, summary, or article                   | **Yes**   |
| `graph <command>`         | Explore knowledge graph (neighbors, path, clusters)    | No        |
| `delta`                   | Show changes since last compilation                    | No        |
| `serve`                   | Local web UI with concept graph visualization          | No        |
| `benchmark`               | Performance metrics (ingest, search, compression)      | No        |
| `status`                  | Wiki statistics                                        | No        |
| `config`                  | View/set API key, model, provider                      | No        |

## Use Cases

**Personal research** — Index 200 papers on a topic. Ask cross-cutting questions. Get answers that synthesize across sources, not just search one at a time.

**LLM context optimization** — Feed Claude, GPT, or any agent the right tokens from a large knowledge base. Compression pipeline cuts API spend 50-70% on context-heavy workflows.

**Technical writing** — Compile scattered reading into structured concept articles. Export as slides for your next meetup or as a markdown article for your blog.

**Developer onboarding** — New team member indexes the project wiki, architecture docs, and RFCs. Asks "how does auth work?" and gets a synthesized answer spanning 15 documents.

**Competitive research** — Index competitor blogs, press releases, and product pages. Ask "what is their pricing strategy?" and get structured analysis across all sources.

**Course material** — Students index lecture notes, textbook chapters, and papers. Search and ask questions across the entire course corpus. Export weekly digests to track what was covered.

**Due diligence** — Index 50 documents about a company. Ask specific questions. The compression pipeline ensures you're not burning tokens on boilerplate while the graph reveals non-obvious connections.

## LLM Integration

### Claude Code (MCP)

```bash
# Coming soon: MCP server addon
npm install -g lumen-mcp
claude mcp add lumen -- lumen-mcp
```

### CLI agents (Cursor, Aider, Copilot)

Add to your `CLAUDE.md`, `.cursorrules`, or equivalent instruction file:

```
Before answering questions about research or knowledge topics, run:
  ! lumen search "<question>" --budget 8000
Use the returned chunks as primary context. Only consult additional sources if needed.
```

### Programmatic (Node.js)

```typescript
import { Store, Search, Graph } from 'lumen-kb';

const store = new Store('~/.lumen');
const search = new Search(store);
const graph = new Graph(store);

// Search with token budget
const results = await search.query('agent orchestration', { budget: 4000 });

// Graph operations
const path = graph.shortestPath('agent-swarm', 'single-agent');
const hubs = graph.pagerank({ top: 10 });
const clusters = graph.clusters();
```

## Configuration

```bash
lumen config --show                              # view current config
lumen config --api-key sk-ant-...                # set Anthropic API key
lumen config --provider openrouter               # switch provider
lumen config --model claude-sonnet-4-20250514    # set model
```

Or set environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # for Anthropic
export OPENROUTER_API_KEY=sk-or-...     # for OpenRouter
```

Supports: **Anthropic** (Claude), **OpenRouter** (multi-model), **Ollama** (local/free).

## Storage

All data lives in `~/.lumen/`:

```
~/.lumen/
├── lumen.db          # SQLite WAL — sources, chunks, FTS5, concepts, edges
├── config.json       # User configuration
├── audit.log         # Append-only JSON-lines operation log
└── output/           # Generated exports (slides, summaries, articles)
```

Everything is a single SQLite database. No separate vector store, no cloud sync, no external services. Back up the `.lumen/` directory and you have everything.

## Documentation

| Document                                                              | Contents                                         |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| [ALGORITHMS.md](./docs/ALGORITHMS.md)                                 | Algorithm details with academic paper references |
| [REFERENCE.md](./docs/REFERENCE.md)                                   | Full CLI reference, configuration, architecture  |
| [TECHNICAL-IMPROVEMENT-PLAN.md](./docs/TECHNICAL-IMPROVEMENT-PLAN.md) | Engineering roadmap and design decisions         |
| [STARTUP-ANALYSIS.md](./docs/STARTUP-ANALYSIS.md)                     | Market analysis and product strategy             |
| [CHANGELOG.md](./CHANGELOG.md)                                        | Version history                                  |

## Algorithms

Every core algorithm is implemented from scratch and documented with academic references:

| Algorithm                 | Use                 | Reference                            |
| ------------------------- | ------------------- | ------------------------------------ |
| BM25                      | Full-text ranking   | Robertson & Zaragoza, 2009           |
| TF-IDF                    | Vector similarity   | Salton & Buckley, 1988               |
| Reciprocal Rank Fusion    | Signal merging      | Cormack, Clarke & Butt, 2009         |
| PageRank                  | Concept importance  | Page, Brin, Motwani & Winograd, 1998 |
| Content-Addressed Storage | Deduplication       | Quinlan & Dorward, 2002              |
| Extractive Summarization  | Compression         | Luhn, 1958                           |
| Label Propagation         | Community detection | Raghavan, Albert & Kumara, 2007      |

## Tech Stack

```
Runtime:     Node.js 18+ / Bun
Language:    TypeScript 5
Storage:     SQLite (better-sqlite3) — WAL mode, FTS5
LLM:         Anthropic SDK / OpenRouter / Ollama
PDF:         pdf-parse
URL:         @extractus/article-extractor
YouTube:     Innertube captions API (no ytdl-core)
arXiv:       Atom API + PDF extraction
CLI:         Commander.js
Lint:        ESLint + Prettier + husky pre-commit
```

Minimal dependency footprint. `better-sqlite3` is the only native addon — everything else is pure JavaScript.

## Development

```bash
git clone https://github.com/your-username/lumen.git
cd lumen
pnpm install
pnpm dev -- status          # run CLI in dev mode
pnpm lint                   # type check
pnpm test                   # run test suite
pnpm build                  # compile to dist/
pnpm benchmark              # run performance benchmarks
```

## Contributing

Contributions are welcome. Please open an issue to discuss before submitting large changes.

Areas where contributions are especially valuable:

- Additional ingestion formats (EPUB, DOCX, RSS feeds)
- Additional chunker formats (RST, LaTeX)
- Search signal implementations (dense embeddings, usage frequency)
- Web UI improvements (concept graph visualization)
- Performance benchmarks on large corpora

## License

This project is licensed under [PolyForm Shield 1.0.0](./LICENSE.md).

You are free to use, modify, and distribute this software for any purpose
**except** competing with the licensor's products or services.

For commercial licensing inquiries, contact: your@email.com
