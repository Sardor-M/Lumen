# lumen-kb

Local-first knowledge compiler. Ingest articles, papers, PDFs, YouTube transcripts, code repositories, datasets (CSV / JSONL / HuggingFace), images with OCR, and Obsidian vault clippings into a searchable knowledge graph — then wire it into Claude Code, Cursor, or any MCP client.

## Install

```bash
npm install -g lumen-kb
```

## Quick start

```bash
# Set up
lumen init
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lumen/.env

# Ingest
lumen add https://karpathy.medium.com/software-2-0-a64152b37c35
lumen add ./papers/attention.pdf
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY
lumen add 1706.03762                                      # arXiv by ID
lumen add https://github.com/anthropics/claude-code       # whole code repo
lumen add ./data/results.csv                              # dataset
lumen add ./diagrams/architecture.png                     # image (OCR)
lumen watch add obsidian ~/ObsidianVault                  # auto-pull clippings

# Compile into knowledge graph
lumen compile -c 3

# Search (local, no LLM)
lumen search "attention mechanism" -b 4000

# Ask (LLM-synthesized, streaming)
lumen ask "How does self-attention work?"
```

## Wire into Claude Code

```bash
lumen install claude
```

One command. Generates `CLAUDE.md` (brain-first protocol), `.mcp.json`, hooks, and a skill file. Claude checks your knowledge base before answering and captures new ideas after every response.

## MCP server

```bash
lumen --mcp    # 19 tools via stdio
```

```json
{ "mcpServers": { "lumen": { "command": "lumen", "args": ["--mcp"] } } }
```

Tools: `search`, `brain_ops`, `compile`, `capture`, `add`, `concept`, `path`, `neighbors`, `god_nodes`, `communities`, `pagerank`, `query`, `status`, `profile`, `session_summary`, `add_link`, `backlinks`, `links`, `community`.

## Commands

| Command          | What it does                                                                          | LLM |
| ---------------- | ------------------------------------------------------------------------------------- | --- |
| `init`           | Create `~/.lumen` workspace                                                           |     |
| `add <input>`    | Ingest URL, PDF, YouTube, arXiv, file, folder, code repo, dataset, image              |     |
| `watch`          | Manage auto-ingest connectors (folder, rss, arxiv, github, obsidian, youtube-channel) |     |
| `compile`        | Extract concepts + edges via LLM                                                      | yes |
| `search <query>` | Hybrid BM25 + TF-IDF + vector search                                                  |     |
| `ask <question>` | Streamed LLM answer from your sources                                                 | yes |
| `enrich`         | Auto-escalate concept tiers via LLM                                                   | yes |
| `embed`          | Generate vector embeddings                                                            | API |
| `graph <sub>`    | pagerank, path, neighbors, report, export                                             |     |
| `profile`        | Corpus summary                                                                        |     |
| `status`         | DB statistics                                                                         |     |
| `install claude` | Wire into Claude Code                                                                 |     |
| `install codex`  | Wire into Codex                                                                       |     |

## How it works

1. **Ingest** — extract content from any source (articles, papers, video transcripts, code repos, datasets, images, Obsidian clippings), chunk structurally, deduplicate via SHA-256, index with FTS5
2. **Compile** — LLM extracts concepts + weighted edges, builds compiled truth + timeline per concept
3. **Search** — BM25 + TF-IDF + vector ANN fused via Reciprocal Rank Fusion, budget-cut by relevance density
4. **Enrich** — concepts auto-escalate from stub (Tier 3) to full knowledge page (Tier 1) as evidence grows
5. **Agent loop** — brain_ops checks KB before answering, capture persists new ideas after responding

## Storage

Everything in `~/.lumen/lumen.db` — one SQLite file. Back it up and you have everything.

## Providers

- **LLM**: Anthropic (Claude), OpenRouter, Ollama
- **Embeddings**: OpenAI, Ollama
- **Default model**: `claude-sonnet-4-6`

## Links

- [npm](https://www.npmjs.com/package/lumen-kb)
- [GitHub](https://github.com/Sardor-M/Lumen)
- MIT Licensed
