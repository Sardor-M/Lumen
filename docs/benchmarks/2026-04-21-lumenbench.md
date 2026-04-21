# LumenBench — 2026-04-21

**Branch:** `docs/benchmark-plan-and-badges`  
**Commit:** `80ce088`  
**Engine:** better-sqlite3 (temp dir, WAL mode)  
**Runtime:** tsx on Node v23.11.0  
**Wall time:** 5.1s

## Summary

6 categories run. 6 passed, 0 failed.

| #   | Category               | Status | Wall time | Script                                |
| --- | ---------------------- | ------ | --------- | ------------------------------------- |
| 1   | Ingest / Chunker       | ✓ pass | 0.3s      | `benchmarks/runner/ingest.ts`         |
| 2   | Search Quality         | ✓ pass | 0.3s      | `benchmarks/runner/search-quality.ts` |
| 3   | Search Latency         | ✓ pass | 2.4s      | `benchmarks/runner/search-latency.ts` |
| 4   | Graph Operations       | ✓ pass | 0.3s      | `benchmarks/runner/graph-ops.ts`      |
| 5   | MCP Contract           | ✓ pass | 0.5s      | `benchmarks/runner/mcp-contract.ts`   |
| 6   | Adversarial Robustness | ✓ pass | 1.3s      | `benchmarks/runner/adversarial.ts`    |

## What LumenBench measures

LumenBench is an engine-level benchmark suite for Lumen — the local-first knowledge compiler.
Every category runs in-process against a fresh temp SQLite database.
No LLM calls, no network, no API keys. Safe to run in CI.

- **Ingest / Chunker** — throughput (docs/sec), per-doc latency, chunk shape
  across markdown, HTML, and plaintext formats.
- **Search Quality** — P@1, P@5, MRR, nDCG@5 comparing BM25, TF-IDF, and
  RRF-fused hybrid on a curated 20-doc corpus with graded queries.
- **Search Latency** — p50 / p95 / p99 at 100, 1K, 10K chunk scales.
- **Graph Operations** — correctness of shortestPath, neighborhood,
  pagerank, godNodes, and community detection on a seeded concept graph.
- **MCP Contract** — valid / invalid input contract for every tool
  dispatched through `handleToolCall`.
- **Adversarial Robustness** — unicode, huge inputs, FTS5 operator strings,
  SQL injection payloads, pathological slugs.

An agent-level benchmark (quality with Claude Code in the loop) is tracked
separately in `docs/docs-temp/BENCHMARK-PLAN.md`.

---

# Category 1: Ingest / Chunker

Status: ✓ PASS (exit 0)
Wall time: 0.27s

```
# LumenBench — ingest / chunker

Generated: 2026-04-21T22:04:02
Corpus: benchmarks/data/corpus-v1
Samples: 462 total across markdown/html/plain (150 per format)

## Throughput

| Format   | Docs | Chunks | Tokens  | Docs/sec | MB/sec | Wall ms |
|----------|------|--------|---------|----------|--------|---------|
| markdown | 150  | 1400   | 48709   | 26689    | 33.13  | 5.6     |
| html     | 150  | 981    | 49529   | 22283.6  | 31.51  | 6.7     |
| plain    | 150  | 681    | 48034   | 40092.2  | 49     | 3.7     |

## Per-document latency

| Format   | p50 ms | p95 ms | p99 ms | mean ms |
|----------|--------|--------|--------|---------|
| markdown | 0.031  | 0.045  | 0.224  | 0.036   |
| html     | 0.037  | 0.048  | 0.244  | 0.044   |
| plain    | 0.019  | 0.029  | 0.147  | 0.024   |

## Chunk shape

| Format   | chunks/doc | token p50 | token p95 |
|----------|------------|-----------|-----------|
| markdown | 9.3        | 28        | 88        |
| html     | 6.5        | 57        | 112       |
| plain    | 4.5        | 67        | 117       |

Format auto-detection: 30/30 samples classified correctly.

## Status

PASS — chunker throughput and latency within expected envelope.
```

---

# Category 2: Search Quality

Status: ✓ PASS (exit 0)
Wall time: 0.27s

```
# LumenBench — search quality

Generated: 2026-04-21T22:04:03
Corpus: 22 docs, Queries: 15

## Headline — ranking quality

| Mode  | P@1     | P@5     | MRR     | nDCG@5  | mean ms |
|-------|---------|---------|---------|---------|---------|
| bm25  | 33.3%   | 9.3%    | 0.333   | 0.206   | 0.05    |
| tfidf | 100.0%  | 40.0%   | 1.000   | 0.949   | 0.17    |
| rrf   | 100.0%  | 40.0%   | 1.000   | 0.908   | 0.01    |

## Per-query top-1 hit (RRF mode)

| id  | query                                             | top-1                   | relevant? |
|-----|---------------------------------------------------|-------------------------|-----------|
| q1  | BM25 formula saturation                           | bm25                    | yes       |
| q2  | reciprocal rank fusion weights                    | hybrid-search           | yes       |
| q3  | PageRank damping factor                           | pagerank                | yes       |
| q4  | how does chunking affect embedding quality        | chunking                | yes       |
| q5  | community detection label propagation             | community-detection     | yes       |
| q6  | FTS5 tokenizer porter stemmer                     | porter-stemmer          | yes       |
| q7  | shortest path between two concepts                | knowledge-graph         | yes       |
| q8  | vector search approximate nearest neighbor        | sqlite-vec              | yes       |
| q9  | why local-first for knowledge tools               | local-first             | yes       |
| q10 | retrieval augmented generation grounding hallucin | rag                     | yes       |
| q11 | Model Context Protocol tools exposed              | mcp                     | yes       |
| q12 | what is intent classification in search           | intent-classification   | yes       |
| q13 | knowledge graph compilation schema                | knowledge-graph         | yes       |
| q14 | prompt caching TTL invalidation                   | prompt-caching          | yes       |
| q15 | concept with most edges central importance        | god-nodes               | yes       |

## Status

PASS — search quality within expected envelope on curated corpus.
```

---

# Category 3: Search Latency

Status: ✓ PASS (exit 0)
Wall time: 2.44s

```
# LumenBench — search latency

Generated: 2026-04-21T22:04:03
Scales: 100, 1000, 10000 chunks. 200 queries per run, 20 warmup.

## Seeding 100 chunks...
  seeded in 4 ms (24400 chunks/sec)
## Seeding 1000 chunks...
  seeded in 30 ms (32854 chunks/sec)
## Seeding 10000 chunks...
  seeded in 321 ms (31111 chunks/sec)

## Latency per scale

| scale  | mode  | p50 ms | p95 ms | p99 ms | mean ms | qps      | seed ms  |
|--------|-------|--------|--------|--------|---------|----------|----------|
| 100    | bm25  | 0.09   | 0.132  | 0.212  | 0.096   | 10469.2  | 4.1      |
| 100    | tfidf | 0.019  | 0.039  | 0.061  | 0.021   | 46551.3  | 4.1      |
| 100    | rrf   | 0.117  | 0.191  | 0.311  | 0.124   | 8095.1   | 4.1      |
| 1000   | bm25  | 0.366  | 0.458  | 0.782  | 0.376   | 2657.1   | 30.4     |
| 1000   | tfidf | 0.173  | 0.243  | 0.442  | 0.18    | 5541.5   | 30.4     |
| 1000   | rrf   | 0.562  | 0.703  | 0.974  | 0.563   | 1777.1   | 30.4     |
| 10000  | bm25  | 3.127  | 3.739  | 6.691  | 3.227   | 309.9    | 321.4    |
| 10000  | tfidf | 3.049  | 4.22   | 6.418  | 3.105   | 322.1    | 321.4    |
| 10000  | rrf   | 6.222  | 7.532  | 12.824 | 6.348   | 157.5    | 321.4    |

## Status

PASS — search latency within envelope at all scales.
```

---

# Category 4: Graph Operations

Status: ✓ PASS (exit 0)
Wall time: 0.29s

```
# LumenBench — graph operations

Generated: 2026-04-21T22:04:05
Graph: 22 concepts, 35 edges

## shortestPath
  PASS bm25 → community-detection: bm25 → hybrid-search → intent-classification → graph-algorithms → community-detection (0.63ms)
  PASS porter-stemmer → knowledge-graph: porter-stemmer → sqlite-fts5 → local-first → mcp → knowledge-graph (0.28ms)
  PASS local-first → pagerank: local-first → mcp → knowledge-graph → pagerank (0.28ms)

## neighborhood
  PASS neighbors(knowledge-graph, d=1) = 7 (0.04ms)
  PASS neighbors(hybrid-search, d=1) = 7 (0.02ms)

## pagerank
  top-3: knowledge-graph, hybrid-search, sqlite-fts5 (1.14ms)

## godNodes
  top-3: knowledge-graph(7), hybrid-search(7), bm25(4) (0.07ms)

## detectCommunities
  runs: 4, 3, 3 (1.51ms avg)

## Status

Checks: 12, passed: 12, failed: 0
PASS — all graph ops return correct results on seeded graph.
```

---

# Category 5: MCP Contract

Status: ✓ PASS (exit 0)
Wall time: 0.48s

```
# LumenBench — MCP contract

Generated: 2026-04-21T22:04:06
Tools in registry: 10

## Registry sanity
  PASS [add] is defined in toolDefinitions
  PASS [search] is defined in toolDefinitions
  PASS [ask] is defined in toolDefinitions
  PASS [status] is defined in toolDefinitions
  PASS [profile] is defined in toolDefinitions
  PASS [god_nodes] is defined in toolDefinitions
  PASS [pagerank] is defined in toolDefinitions
  PASS [neighbors] is defined in toolDefinitions
  PASS [path] is defined in toolDefinitions
  PASS [communities] is defined in toolDefinitions

## status
  PASS [status] returns object with counts

## search
  PASS [search] valid query returns array
  PASS [search] missing `query` rejected
  PASS [search] numeric `query` rejected
  PASS [search] invalid `mode` rejected

## god_nodes
  PASS [god_nodes] returns array
  PASS [god_nodes] empty args valid (defaulted limit)

## pagerank
  PASS [pagerank] returns array

## neighbors
  PASS [neighbors] valid slug returns result
  PASS [neighbors] missing `slug` rejected
  PASS [neighbors] string `depth` rejected

## path
  PASS [path] seeded path alpha→gamma resolves
  PASS [path] nonexistent target returns null (no throw)
  PASS [path] missing `to` rejected

## communities
  PASS [communities] returns array

## profile
  PASS [profile] returns object
  PASS [profile] string `refresh` rejected

## add
  PASS [add] missing `input` rejected
  PASS [add] empty `input` rejected

## ask (arg validation only — requires API key for success)
  PASS [ask] missing `question` rejected
  PASS [ask] string `limit` rejected

## unknown tool
  PASS [unknown] unknown tool name throws

## Status

Checks: 32, passed: 32, failed: 0
PASS — every tool accepts valid input and rejects invalid input as contracted.
```

---

# Category 6: Adversarial Robustness

Status: ✓ PASS (exit 0)
Wall time: 1.32s

```
# LumenBench — adversarial robustness

Generated: 2026-04-21T22:04:06

## chunker — pathological inputs
  PASS [chunker] empty string does not throw
  PASS [chunker] whitespace-only does not throw
  PASS [chunker] 300KB punctuated input does not throw
  PASS [chunker] 48KB unpunctuated input completes within 10s
  PASS [chunker] null bytes do not crash
  PASS [chunker] unicode / CJK / Arabic / emoji do not crash

## search — adversarial queries
  PASS [search-bm25] FTS5 operator string "alpha AND beta"
  PASS [search-bm25] FTS5 operator string "alpha OR beta"
  PASS [search-bm25] FTS5 operator string "alpha NOT beta"
  PASS [search-bm25] FTS5 operator string "alpha NEAR beta"
  PASS [search-bm25] FTS5 operator string "alpha "beta""
  PASS [search-bm25] FTS5 operator string "alpha OR OR beta"
  PASS [search-bm25] FTS5 operator string "(alpha AND beta)"
  PASS [search-bm25] FTS5 operator string ""unterminated"
  PASS [search-bm25] FTS5 operator string """
  PASS [search-bm25] FTS5 operator string "alpha*"
  PASS [search-injection] bm25 resists "'; DROP TABLE chunks; --"
  PASS [search-injection] tfidf resists "'; DROP TABLE chunks; --"
  PASS [search-injection] bm25 resists "' OR '1'='1"
  PASS [search-injection] tfidf resists "' OR '1'='1"
  PASS [search-injection] bm25 resists ""; SELECT * FROM sources; --"
  PASS [search-injection] tfidf resists ""; SELECT * FROM sources; --"
  PASS [search-injection] bm25 resists "\x00\x01\x02"
  PASS [search-injection] tfidf resists "\x00\x01\x02"
  PASS [search-injection] bm25 resists " injection"
  PASS [search-injection] tfidf resists " injection"
  PASS [search-edge] bm25 handles empty string
  PASS [search-edge] bm25 handles whitespace only
  PASS [search-edge] bm25 handles 5K-char single term
  PASS [search-edge] bm25 handles 500 terms

## graph — adversarial inputs
  PASS [graph-neighbors] neighborhood(empty) does not crash
  PASS [graph-path] shortestPath(empty, beta) does not crash
  PASS [graph-neighbors] neighborhood(whitespace) does not crash
  PASS [graph-path] shortestPath(whitespace, beta) does not crash
  PASS [graph-neighbors] neighborhood(path-traversal) does not crash
  PASS [graph-path] shortestPath(path-traversal, beta) does not crash
  PASS [graph-neighbors] neighborhood(null-byte) does not crash
  PASS [graph-path] shortestPath(null-byte, beta) does not crash
  PASS [graph-neighbors] neighborhood(huge-slug) does not crash
  PASS [graph-path] shortestPath(huge-slug, beta) does not crash
  PASS [graph-neighbors] neighborhood(unicode) does not crash
  PASS [graph-path] shortestPath(unicode, beta) does not crash
  PASS [graph-pagerank] pagerank does not crash on small graph
  PASS [graph-godNodes] godNodes with huge limit does not crash

## Status

Checks: 44, passed: 44, failed: 0
PASS — no input crashed the engine; SQL injection parameterized safely.
```

---

## How to reproduce

```bash
# Combined run — writes report to docs/benchmarks/
pnpm --filter @lumen/cli bench

# Or run a single category:
npx tsx benchmarks/runner/ingest.ts
npx tsx benchmarks/runner/search-quality.ts
npx tsx benchmarks/runner/search-latency.ts
npx tsx benchmarks/runner/graph-ops.ts
npx tsx benchmarks/runner/mcp-contract.ts
npx tsx benchmarks/runner/adversarial.ts
```

All runs target a temp SQLite database — your real `~/.lumen` is never touched.
