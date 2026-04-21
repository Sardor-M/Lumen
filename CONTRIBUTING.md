# Contributing to Lumen

Thanks for your interest in contributing. This document covers the basics.

## Getting started

```bash
git clone https://github.com/Sardor-M/Lumen.git
cd lumen
pnpm install
pnpm dev          # runs CLI + web in parallel
```

## Before submitting a PR

```bash
pnpm lint         # ESLint + tsc --noEmit across all workspaces
pnpm format:check # Prettier check
pnpm test         # Vitest
```

All three must pass. Husky runs lint + format on pre-commit automatically.

## Code conventions

- **`type` not `interface`** — always, no exceptions
- **JSDoc comments** (`/** */`), not `//`
- **`.js` extensions** in all relative imports (ESM requires it)
- **`import type`** for type-only imports
- **No classes** — plain functions and types only
- **No default exports** (except Next.js framework files in `apps/web/`)
- **No enums** — use union types: `type Foo = 'a' | 'b'`
- **No `any`** — use `unknown` or specific types
- **No `console.log`** in CLI commands — use `log.info/success/warn/error`
- **No `process.exit()`** — set `process.exitCode = 1` instead

## Project structure

```
apps/cli/src/
  commands/     — CLI commands (registerX pattern)
  store/        — SQLite CRUD (getDb singleton)
  search/       — BM25, TF-IDF, vector, fusion
  graph/        — PageRank, BFS, clustering
  llm/          — LLM client + prompts
  mcp/          — MCP server (19 tools)
  ingest/       — Format extractors
  chunker/      — Structural chunking
  compress/     — 4-stage compression
  enrich/       — Tiered enrichment
  classify/     — Intent classification
  types/        — All types in index.ts
```

## Tests

Tests use temp directories to avoid writing to `~/.lumen`:

```bash
LUMEN_DIR=$(mktemp -d) pnpm --filter @lumen/cli test
```

## High-value contribution areas

- Additional ingest formats (EPUB, DOCX, RSS)
- Additional chunker formats (RST, LaTeX)
- Delta module implementation (smart recompilation)
- Web dashboard live graph visualization
- Performance benchmarks

## Opening issues

Open an issue before starting large changes. Include:

- What you want to change and why
- Which files you expect to modify
- Whether it requires a schema migration
