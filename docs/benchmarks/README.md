# LumenBench

Engine-level benchmark suite for Lumen — the local-first knowledge compiler.
Every category runs in-process against a fresh temp SQLite database. No LLM
calls, no network, no API keys. Safe to run in CI; total wall time under
two minutes on a modern laptop.

> For agent-level evaluation (Claude Code wired to Lumen via MCP, measuring
> answer quality end-to-end), see `docs/docs-temp/BENCHMARK-PLAN.md`.

## Categories

| #   | Category                   | What it measures                                                                                                      |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ingest / Chunker**       | Throughput (docs/sec, MB/sec) and per-doc latency across markdown, HTML, and plaintext. Chunk-shape distribution.     |
| 2   | **Search Quality**         | P@1, P@5, MRR, nDCG@5 comparing BM25, TF-IDF, and RRF-fused hybrid on a curated 20-doc corpus with graded queries.    |
| 3   | **Search Latency**         | p50 / p95 / p99 at 100, 1K, 10K chunk scales. Throughput in qps.                                                      |
| 4   | **Graph Operations**       | Correctness of `shortestPath`, `neighborhood`, `pagerank`, `godNodes`, `detectCommunities` on a seeded concept graph. |
| 5   | **MCP Contract**           | Valid / invalid input contract for every tool dispatched through `handleToolCall`.                                    |
| 6   | **Adversarial Robustness** | Unicode, huge inputs, FTS5 operator strings, SQL-injection payloads, pathological slugs.                              |

## Running

```bash
# Full suite — writes a dated report to docs/benchmarks/
pnpm bench

# Or via the cli workspace
pnpm --filter lumen-kb bench

# Individual categories
pnpm --filter lumen-kb bench:ingest
pnpm --filter lumen-kb bench:search
pnpm --filter lumen-kb bench:latency
pnpm --filter lumen-kb bench:graph
pnpm --filter lumen-kb bench:mcp
pnpm --filter lumen-kb bench:adversarial

# Raw tsx — from repo root
npx tsx benchmarks/runner/all.ts
npx tsx benchmarks/runner/ingest.ts --json
```

Add `--json` to any single-category runner to suppress the markdown log and
emit a JSON blob instead — useful for diffing across runs or piping into a
dashboard.

## Layout

```
benchmarks/
  data/
    corpus-v1/              — 20 curated markdown docs + graded queries
                              + seeded concept graph (edges.json)
  runner/
    all.ts                  — combined runner, writes the dated report
    ingest.ts
    search-quality.ts
    search-latency.ts
    graph-ops.ts
    mcp-contract.ts
    adversarial.ts

docs/benchmarks/
  README.md                 — this file
  YYYY-MM-DD-lumenbench.md  — dated run reports, committed to git
```

## Reports

Each `all.ts` run writes `docs/benchmarks/YYYY-MM-DD-lumenbench.md`. The
report has a summary table, per-category expanded output, and a
reproducibility footer (branch, commit, Node version, total wall time).

Reports are intentionally committed — run diffs surface regressions between
branches and give a historical record of engine performance.

## What LumenBench does NOT cover (by design)

- **LLM-backed tools (`ask`, `compile`)**: excluded from the success path
  because they require an API key and are non-deterministic. The MCP-contract
  category still exercises their input validation layer.
- **Real ingest (URL / PDF / YouTube / arXiv)**: excluded because they depend
  on the network and external services. Unit tests in
  `apps/cli/tests/ingest-*.test.ts` cover those extractors.
- **Vector search**: excluded because it needs an embedding provider. Hybrid
  search falls back to BM25 + TF-IDF when `embedding.provider === 'none'`,
  which is what the benchmarks exercise.
- **Answer quality**: agent-level evaluation lives in a separate plan — see
  `docs/docs-temp/BENCHMARK-PLAN.md`.

## Isolation contract

Every benchmark that touches the store:

1. Creates a fresh `mkdtempSync(...)` directory.
2. Calls `setDataDir(tempDir)` so `better-sqlite3` opens a file there.
3. Runs, then `closeDb()` + `resetDataDir()` + `rmSync(tempDir)`.

Your real `~/.lumen/lumen.db` is never opened. Running the suite in parallel
is safe (each category owns its own temp dir).

## Updating the corpus

The curated corpus at `benchmarks/data/corpus-v1/` is stable — touching it
invalidates historical comparisons. If you need a bigger or different corpus,
add `benchmarks/data/corpus-v2/` and update the relevant runners to accept a
corpus path. Preserve v1 so older reports stay meaningful.
