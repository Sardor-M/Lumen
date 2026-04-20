# Lumen

You read constantly. Articles, papers, transcripts, YouTube talks, PDFs. Then you forget most of it.

Your AI assistant has the same problem — worse, actually. It doesn't know anything you've read. Every conversation starts from zero. You paste the same context, re-explain the same ideas, re-answer the same questions about your own domain. The model knows the world but doesn't know _your_ world.

Lumen fixes that. Drop everything you've read into it and it builds a local knowledge graph — concepts, edges, connections — that your AI assistant can search before it answers. `lumen install claude` wires it directly into Claude Code with a `CLAUDE.md` brain-first protocol: the assistant checks your brain before the internet, cites your sources, and captures new ideas after every response.

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
lumen compile -c 3                            # extract concepts + build graph (3 parallel)
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
pnpm install
pnpm --filter @lumen/cli build
cd apps/cli && npm link && cd ../..    # makes `lumen` global
```

npm package coming soon.

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
lumen --mcp          # stdio server, 19 tools
```

Add to your client's MCP config:

```json
{
    "mcpServers": {
        "lumen": { "command": "lumen", "args": ["--mcp"] }
    }
}
```

19 tools: `search`, `query`, `brain_ops`, `add`, `compile`, `capture`, `session_summary`, `status`, `profile`, `god_nodes`, `concept`, `path`, `neighbors`, `pagerank`, `communities`, `community`, `add_link`, `backlinks`, `links`.

### Cursor / Aider / Copilot (no MCP)

Add this to your instruction file (`.cursorrules`, `CLAUDE.md`, etc.):

```
Before answering research questions, run:
  ! lumen search "<question>" -b 8000
Use the returned chunks as primary context.
```

---

## The agent loop

This is how it works end to end when an agent is connected:

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
Agent calls capture(type, title, content, related_slugs)
        |
        v
Concept upserted + timeline entry + backlinks created
        |
        v
Brain is richer for the next conversation
```

Every cycle adds knowledge. The agent enriches concepts after conversations. Next time the same topic comes up, `brain_ops` finds it. The difference compounds daily.

---

## How the brain compounds over time

Every concept starts at Tier 3 — a stub. As you add more sources that reference it, the tier climbs:

- **Tier 3** — mentioned once. Stub with basic summary.
- **Tier 2** — mentioned 3+ times across 2+ sources. Enriched with connections and context.
- **Tier 1** — mentioned 6+ times across 3+ sources. Full compiled truth — the system's current best understanding of this concept, synthesized from everything you've read.

Run `lumen enrich` to process the queue, or `lumen enrich --status` to see where things stand. After `compile`, any concepts that crossed a threshold are automatically queued.

The `capture` MCP tool writes the other direction — from conversation to graph. When the assistant is discussing something worth remembering, it calls `capture` with the exact phrasing. `session_summary` closes out a session with a digest of what was covered.

---

## How it works

```
    INGEST              CHUNK               STORE              SEARCH
    ------              -----               -----              ------

  URL     -+          +- Markdown         +- Sources         +- BM25 (FTS5)
  PDF     -|          |                   |                  |
  YouTube -+- Extract +- HTML        -->  +- Chunks    -->   +- TF-IDF
  arXiv   -|          |                   |                  |
  File    -|          +- Plain text       +- Concepts        +- Vector ANN
  Dir     -+                              +- Edges           |
                                          +- Links           +- Graph walk
                                          +- Embeddings            |
                                                                    v
    COMPILE             ENRICH              GRAPH            RRF Fusion
    -------             ------              -----          (3-signal merge)
                                                                   |
  LLM extracts       Tier scoring        PageRank            Budget cut
  concepts +         escalates           Path finding              |
  compiled truth     stubs ->            Community            Ranked chunks
  + timeline         rich pages          detection                 |
  per source         via LLM             Visualization             v
  (3 parallel)                                               LLM synthesis
                                                              (streaming)
```

**Ingestion** — no LLM needed. URL scraping via `@extractus/article-extractor`, PDF via `pdf-parse`, YouTube transcripts via the Innertube captions API, arXiv via Atom + PDF. SHA-256 deduplication so the same quote across five sources costs one row.

**Compilation** — LLM pass. Extracts concepts and relations from stored chunks, writes them as nodes and weighted directed edges with compiled truth + timeline per concept. Delta-aware: `compile` only touches unprocessed sources. `compile --all` reprocesses everything. `compile -c 5` runs 5 sources in parallel. `compile --model claude-haiku-4-5-20251001` uses a faster/cheaper model.

**Search** — local, no LLM. BM25 via SQLite FTS5 (Porter stemmed), TF-IDF via in-memory inverted index (cosine similarity), optional vector ANN via sqlite-vec (OpenAI or Ollama embeddings). Fused with Reciprocal Rank Fusion (`score = Σ weight / (k + rank)`, k=60), ranked by relevance density so small high-value chunks beat verbose low-value ones.

**Synthesis** — LLM pass with prompt caching (`cache_control: ephemeral`, ~60-80% cost reduction on repeated calls within a session). `lumen ask` streams tokens to stdout as they arrive. Non-Anthropic providers fall back gracefully.

---

## CLI reference

| Command                | What it does                                            | LLM |
| ---------------------- | ------------------------------------------------------- | --- |
| `init`                 | Create `~/.lumen` workspace                             |     |
| `add <input>`          | Ingest URL, PDF, YouTube, arXiv, file, or folder        |     |
| `compile`              | Extract concepts + edges from unprocessed sources       | yes |
| `enrich`               | Tier-score concepts and LLM-enrich queued ones          | yes |
| `embed`                | Generate vector embeddings for chunks                   | API |
| `search <query>`       | Hybrid local search (BM25 + TF-IDF + vector + graph)    |     |
| `ask <question>`       | Search + streamed LLM-synthesized answer                | yes |
| `graph <subcommand>`   | Overview, pagerank, path, neighbors, report, export     |     |
| `profile`              | Corpus summary — sources, density, frequent queries     |     |
| `status`               | DB statistics (text or JSON)                            |     |
| `memory export/import` | Portable JSONL or SQL backup                            |     |
| `serve`                | Start the web UI against your local knowledge base      |     |
| `install <platform>`   | Wire into Claude Code (`claude`) or Codex (`codex`)     |     |
| `watch`                | Watch a folder and auto-ingest changes                  |     |
| `daemon`               | Install/uninstall as background launchd/systemd service |     |

Compile options: `lumen compile -c 5` (5 parallel), `lumen compile --model claude-haiku-4-5-20251001` (faster model).

Search options: `lumen search "query" -n 5` (limit results), `lumen search "query" -b 4000` (token budget).

Graph subcommands: `lumen graph status`, `lumen graph pagerank`, `lumen graph path <a> <b>`, `lumen graph neighbors <concept> -d 2`, `lumen graph report`, `lumen graph export -f json`.

---

## Repo layout

Monorepo — Turborepo + pnpm workspaces.

```
lumen/
+-- apps/
|   +-- cli/         -- CLI and MCP server (the engine)
|   +-- web/         -- Next.js 15 web UI (Better Auth, Zod, shadcn)
|   +-- extension/   -- Browser extension (placeholder)
+-- docs/            -- ALGORITHMS.md, architecture, test plans
+-- test-benchmarks/ -- Side-by-side Mode 1 (bare) vs Mode 2 (agent wired)
+-- turbo.json
+-- pnpm-workspace.yaml
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
+-- lumen.db          # SQLite WAL -- sources, chunks, FTS5, concepts, edges,
|                     #   links, embeddings, classifiers, query_log
+-- config.json       # User config (LLM model, embedding provider, search weights)
+-- .env              # API keys (always checked, even if LUMEN_DIR is set elsewhere)
+-- audit.log         # Append-only JSON-lines operation log
+-- output/           # Generated exports and reports
```

One file. Back it up and you have everything.

---

## Algorithms

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
Vectors:     sqlite-vec (ANN search, cosine similarity)
LLM:         @anthropic-ai/sdk (+ OpenRouter, Ollama)
Embeddings:  OpenAI text-embedding-3-small / Ollama nomic-embed-text
PDF:         pdf-parse
URL:         @extractus/article-extractor
YouTube:     Innertube captions API
arXiv:       Atom API + PDF extraction
CLI:         Commander.js
MCP:         @modelcontextprotocol/sdk (19 tools)
Web:         Next.js 15, Better Auth, Zod, shadcn/ui, Tailwind
Monorepo:    Turborepo + pnpm workspaces
```

---

## Privacy

The only network calls are: (a) fetching the URL or arXiv paper you asked to ingest, (b) model API calls during `compile`, `enrich`, and `ask` using your own API key, and (c) embedding API calls during `embed` if configured. No telemetry. No analytics. Search, graph traversal, compression, chunking, and deduplication all run locally against the SQLite file.

---

## Development

```bash
pnpm install
pnpm dev                          # turbo dev -- all apps in parallel
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
- Additional chunker formats (RST, LaTeX)
- Web dashboard — live graph visualization
- Mastra and LangChain adapter improvements

---

## License

[PolyForm Shield 1.0.0](./LICENSE.md) -- free to use, modify, and distribute for any purpose except competing with the licensor's products or services. Commercial licensing: sardor0968@gmail.com.
