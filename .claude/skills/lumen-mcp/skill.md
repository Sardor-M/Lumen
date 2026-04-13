---
name: lumen-mcp
description: Search, query, and explore the Lumen knowledge base via MCP tools. TRIGGER when user invokes /lumen or asks about their knowledge base, sources, concepts, or graph.
---

# Lumen Knowledge Base

You have access to a local Lumen knowledge base via MCP tools. All data is stored in SQLite on the user's machine.

## Available MCP Tools

| Tool          | When to use                                                   |
| ------------- | ------------------------------------------------------------- |
| `search`      | Find content by keyword — returns ranked chunks with snippets |
| `query`       | Ask a question — synthesizes an answer from chunks via LLM    |
| `status`      | Quick stats — source count, chunk count, concept count, edges |
| `god_nodes`   | Find the most connected concepts (highest edge count)         |
| `concept`     | Deep dive into one concept — summary, edges, sources          |
| `path`        | Find how two concepts connect (shortest path)                 |
| `neighbors`   | Explore around a concept within N hops                        |
| `pagerank`    | Rank concepts by structural importance                        |
| `communities` | List topic clusters detected by label propagation             |
| `community`   | Members of a specific cluster by ID                           |
| `add`         | Ingest a new source (URL, file, arXiv, YouTube)               |

## Decision Guide

- **"What do you know about X?"** → `search` first, then `query` if user wants synthesis
- **"What are the main topics?"** → `god_nodes` or `pagerank`
- **"How does X relate to Y?"** → `path`
- **"Show me everything near X"** → `neighbors`
- **"What clusters exist?"** → `communities`, then `community` for detail
- **"Add this article"** → `add`

## Gotchas

- `search` returns raw chunks. `query` calls the LLM to synthesize — it costs API tokens.
- `community` IDs are ephemeral — recomputed on each call. Don't cache them across sessions.
- `add` deduplicates by content hash. Adding the same URL twice is safe.
- `path` returns null if no path exists — concepts may be in disconnected components.
- `god_nodes` and `pagerank` return empty arrays if `lumen compile` hasn't been run yet.
