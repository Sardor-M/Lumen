# Hybrid Search

Hybrid search combines keyword retrievers (BM25, TF-IDF) with a dense
retriever (vector search) to get the benefits of both. Keyword retrievers
excel at exact-match queries; dense retrievers excel at paraphrased or
semantically similar queries. Fusing them consistently beats either alone
on mixed workloads.

## Lumen's approach

Lumen runs three retrievers in parallel:

- **BM25** via SQLite FTS5 (see sqlite-fts5.md).
- **TF-IDF** computed in-process (see tfidf.md).
- **Vector similarity** via `sqlite-vec` when embeddings are available
  (see vector-search.md).

The three ranked lists are fused with Reciprocal Rank Fusion (see rrf.md)
using configurable per-signal weights. Default weights are balanced when
vector search is off, and weighted 0.35 / 0.30 / 0.35 when it's on.

## Intent routing

Not every query needs retrieval. "Who is X?" is better served by a direct
concept page lookup; "path from X to Y" is a graph query. Lumen classifies
query intent before dispatching to the retriever — entity lookups and graph
queries skip the full hybrid pipeline.

## Token budget

Retrieval typically over-fetches — 20 or more passages — and filters down
to fit a token budget for the LLM. Lumen's budget selector takes the
highest-scoring passages until the budget is exhausted.
