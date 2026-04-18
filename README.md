# Lumen

You read constantly. Articles, papers, transcripts, YouTube talks, PDFs. Then you forget most of it.

Your AI assistant has the same problem — worse, actually. It doesn't know anything you've read. Every conversation starts from zero. You paste the same context, re-explain the same ideas, re-answer the same questions about your own domain. The model knows the world but doesn't know _your_ world.

Lumen fixes that. Drop everything you've read into it and it builds a local knowledge graph — concepts, edges, connections — that your AI assistant can search before it answers. `lumen install claude` wires it directly into Claude Code. The assistant checks your brain first, then the internet.

Everything runs on your machine. One SQLite file. No cloud, no server, no syncing. The LLM is only called when you ask it to compile or synthesize — search, indexing, graph traversal, and compression all run locally.

---

## What it looks like in practice

```bash
lumen init
lumen add https://karpathy.github.io/2021/06/21/blockchain/
lumen add ./papers/attention-is-all-you-need.pdf
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY
lumen add 1706.03762                          # arXiv ID
lumen add ./saved-articles/                   # whole folder at once
lumen compile                                 # extract concepts + build graph
```

Now search it:

```bash
lumen search "agent orchestration patterns"
```

```
1. concepts/agent-swarm (score: 0.94)
   Collective behavior pattern where multiple specialized agents cooperate.
   [Sources: attention.pdf, karpathy.com, arxiv:1706.03762]

2. concepts/single-agent-loop (score: 0.87)
   Tool-call loop driving a single reasoning model.
   Connected to: planning, memory, tool-use

3. concepts/rag-retrieval (score: 0.81)
   Augmenting generation with retrieved chunks. Connected to 9 other concepts.
```

Or ask a question and get a synthesized answer:

```bash
lumen ask "How do agent swarms compare to RAG for knowledge retrieval?"
```

Claude reads the relevant chunks from your corpus and answers — not from training data, from what you've actually read.

---

## Install

```bash
pnpm install
pnpm --filter @lumen/cli build
# from apps/cli/
npm link                         # makes `lumen` global
```

npm package coming soon.

Set your API key once:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lumen/.env
```

Supports Anthropic (Claude), OpenRouter (multi-model), and Ollama (local).

---

## Wire it into your AI assistant

### Claude Code

```bash
lumen install claude
```

This drops a skill file and installs two hooks:

- **PreToolUse hook** — fires before every `Glob` / `Grep`. If your knowledge base has content, it reminds the assistant to check the graph first.
- **Stop hook** — fires after every assistant response. If the conversation contained new knowledge — a new idea, a person, a concept — it nudges the assistant to call `capture` and save it.

After that, every conversation the assistant has in this project can draw from and add to your knowledge base automatically.

### MCP server (Cursor, Codex, any MCP client)

```bash
lumen --mcp          # stdio server
```

Add to your client's MCP config:

```json
{
    "mcpServers": {
        "lumen": { "command": "lumen", "args": ["--mcp"] }
    }
}
```

Exposes 15 tools: `search`, `query`, `add`, `capture`, `brain_ops`, `session_summary`, `status`, `god_nodes`, `concept`, `path`, `neighbors`, `pagerank`, `communities`, `community`, `profile`.

### Cursor / Aider / Copilot (no MCP)

Add this to your instruction file (`.cursorrules`, `CLAUDE.md`, etc.):

```
Before answering research questions, run:
  ! lumen search "<question>" --budget 8000
Use the returned chunks as primary context.
```

---

## How the brain compounds over time

The first time you compile a source, Lumen extracts concepts and builds edges. That's the base graph. What makes it grow is the enrichment loop.

Every concept starts at Tier 3 — a stub. As you add more sources that reference it, the tier climbs:

- **Tier 3** — mentioned once. Stub with basic summary.
- **Tier 2** — mentioned 3+ times across 2+ sources. Enriched with connections and context.
- **Tier 1** — mentioned 6+ times across 3+ sources. Full compiled truth — the system's current best understanding of this concept, synthesized from everything you've read.

Run `lumen enrich` to process the queue, or `lumen enrich --status` to see where things stand. After `compile`, any concepts that crossed a threshold are automatically queued.

The `capture` MCP tool writes the other direction — from conversation to graph. When the assistant is discussing something worth remembering, it calls `capture` with the exact phrasing. `session_summary` closes out a session with a digest of what was covered. Neither require LLM calls to search; they're fast writes that feed the next enrichment run.

---

## How it works

```
    INGEST              CHUNK               STORE              SEARCH
    ──────              ─────               ─────              ──────

  URL     ─┐          ┌─ Markdown         ┌─ Sources         ┌─ BM25 (FTS5)
  PDF     ─┤          │                   │                  │
  YouTube ─┼─ Extract ┼─ HTML        ──►  ├─ Chunks    ──►   ├─ TF-IDF
  arXiv   ─┤          │                   │                  │
  File    ─┤          └─ Plain text       ├─ Concepts        └─ Graph walk
  Dir     ─┘                              └─ Edges                 │
                                                                    ▼
    COMPILE             ENRICH              GRAPH            RRF Fusion
    ───────             ──────              ─────                   │
                                                               Budget cut
  LLM extracts       Tier scoring        PageRank                   │
  concepts +         escalates           Path finding          Ranked chunks
  weighted edges     stubs →             Clustering                 │
  per source         compiled truth      Visualization              ▼
                                                             LLM synthesis
```

**Ingestion** — no LLM needed. URL scraping via `@extractus/article-extractor`, PDF via `pdf-parse`, YouTube transcripts via the Innertube captions API, arXiv via Atom + PDF. SHA-256 deduplication so the same quote across five sources costs one row.

**Compilation** — LLM pass. Extracts concepts and relations from stored chunks, writes them as nodes and weighted directed edges. Delta-aware: `compile` only touches unprocessed sources. `compile --all` reprocesses everything.

**Search** — local, no LLM. BM25 via SQLite FTS5, TF-IDF via inverted index, graph walk via the concept graph. Fused with Reciprocal Rank Fusion (`score = Σ weight / (k + rank)`, k=60), ranked by relevance density so small high-value chunks beat verbose low-value ones.

**Synthesis** — LLM pass. Selected chunks sent to Claude (streaming), OpenRouter, or Ollama. `lumen ask` streams tokens to stdout as they arrive.

---

## CLI reference

| Command                | What it does                                                | LLM |
| ---------------------- | ----------------------------------------------------------- | --- |
| `init`                 | Create `~/.lumen` workspace                                 |     |
| `add <input>`          | Ingest URL, PDF, YouTube, arXiv, file, or folder            |     |
| `compile`              | Extract concepts and edges from unprocessed sources         | yes |
| `enrich`               | Tier-score concepts and LLM-enrich queued ones              | yes |
| `search <query>`       | Hybrid local search (BM25 + TF-IDF + graph)                 |     |
| `ask <question>`       | Search + streamed LLM-synthesized answer                    | yes |
| `graph <subcommand>`   | Overview, pagerank, path, neighbors, report, export         |     |
| `profile`              | Corpus summary — sources, density, recent, frequent queries |     |
| `status`               | DB statistics as text or JSON                               |     |
| `memory export/import` | Portable JSONL or SQL backup                                |     |
| `serve`                | Start the web UI against your local knowledge base          |     |
| `install <platform>`   | Wire into Claude Code (`claude`) or Codex (`codex`)         |     |
| `watch`                | Watch a folder and auto-ingest changes                      |     |
| `daemon`               | Install/uninstall as a background launchd/systemd service   |     |

Graph subcommands: `lumen graph` (overview), `lumen graph pagerank`, `lumen graph path <a> <b>`, `lumen graph neighbors <concept> -d 2`, `lumen graph report` (writes `GRAPH_REPORT.md`), `lumen graph export -f json`.

---

## Repo layout

Monorepo — Turborepo + pnpm workspaces.

```
lumen/
├── apps/
│   ├── cli/         — CLI and MCP server (the engine)
│   ├── web/         — Next.js 15 web UI (Better Auth, Zod, shadcn)
│   └── extension/   — Browser extension (placeholder)
├── .claude/skills/  — Claude Code skills for working in this repo
├── docs/            — ALGORITHMS.md, REFERENCE.md, roadmap
├── turbo.json
└── pnpm-workspace.yaml
```

---

## Web UI

`lumen serve` starts a Next.js 15 app that reads directly from `~/.lumen/lumen.db`. No separate server, no duplicate query code.

Pages: overview (sources / concepts / edges / density / pending), hybrid search with per-signal score breakdown, concept browser, concept detail (neighborhood, edges), sources list, and graph dashboard (god nodes, communities, top concepts).

```bash
lumen serve                          # dev mode, http://localhost:3000
lumen serve --port 4000 --mode prod  # after pnpm build in apps/web
```

---

## Storage

Everything in `~/.lumen/`:

```
~/.lumen/
├── lumen.db          # SQLite WAL — sources, chunks, FTS5, concepts, edges, query_log
├── config.json       # User configuration
├── .env              # API keys (optional)
├── audit.log         # Append-only JSON-lines operation log
└── output/           # Generated exports
```

One file. Back it up and you have everything. No vector store, no cloud sync, no server process.

---

## Algorithms

Every core algorithm is documented with its academic reference.

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

---

## Tech stack

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

---

## Privacy

The only network calls are: (a) fetching the URL or arXiv paper you asked to ingest, and (b) model API calls during `compile`, `enrich`, and `ask` using your own API key. No telemetry. No analytics. Search, graph traversal, compression, chunking, and deduplication all run locally against the SQLite file.

---

## Development

```bash
pnpm install
pnpm dev                          # turbo dev — all apps in parallel
pnpm --filter @lumen/cli dev      # CLI only
pnpm --filter @lumen/web dev      # web only
pnpm build
pnpm lint && pnpm format:check    # pre-commit check
pnpm test                         # vitest
```

Tests use a temp directory: `LUMEN_DIR=$(mktemp -d)`.

---

## Contributing

Open an issue before large changes. High-value areas:

- Additional ingest formats (EPUB, DOCX, RSS)
- Dense embedding signal for hybrid search (vector store integration)
- Additional chunker formats (RST, LaTeX)
- Web dashboard — live graph visualization
- Wire stub commands: `config`, `delta`, `digest`, `export`, `lint`, `benchmark`

---

## License

[PolyForm Shield 1.0.0](./LICENSE.md) — free to use, modify, and distribute for any purpose except competing with the licensor's products or services. Commercial licensing: sardor0968@gmail.com.
