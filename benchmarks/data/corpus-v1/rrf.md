# Reciprocal Rank Fusion (RRF)

RRF is a simple, parameter-light method for combining ranked lists from
multiple retrieval signals. Introduced by Cormack, Clarke, and Büttcher in
2009, it routinely outperforms learned fusion methods on information-retrieval
benchmarks despite having no trainable parameters.

## Formula

Given several ranked lists (e.g. from BM25, TF-IDF, and a vector retriever),
the RRF score for a document `d` is:

```
rrf(d) = Σ weight_i · (1 / (k + rank_i(d)))
```

where `k` is a small smoothing constant (typical value 60) and `rank_i(d)`
is the 1-based rank of `d` in list `i`. Documents that appear near the top
of multiple lists accumulate score; documents that appear far down any single
list contribute almost nothing.

## Why k = 60

The choice of `k` controls how steeply top ranks dominate. Small `k` rewards
top-1 heavily; large `k` flattens the contribution curve. Empirically `k=60`
gives a good balance for mixed-signal fusion and is Cormack's original
recommendation.

## Use in Lumen

Lumen's hybrid search fuses BM25, TF-IDF, and vector similarity with RRF,
using configurable per-signal weights. See sqlite-fts5.md and vector-search.md
for the underlying retrievers.
