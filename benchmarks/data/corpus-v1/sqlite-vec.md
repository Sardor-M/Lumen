# sqlite-vec

`sqlite-vec` is a SQLite extension that adds vector similarity search in a
single native library. It exposes `vec0` virtual tables for storing and
querying float32 vectors, with built-in cosine, L2, and dot-product
distance functions.

## Why it's useful for Lumen

Lumen's whole premise is "local-first" — no external database services. A
vector search layer that lives inside the same SQLite file as the content
tables means one file on disk, one connection, one transactional guarantee.
No sync jobs between Postgres and Pinecone; no API keys to manage; no
network round-trips on every query.

## Tradeoffs

The extension currently supports exact nearest-neighbor search, not HNSW
(see vector-search.md). For corpora under ~100K vectors this is fast enough
on a laptop. Beyond that, an approximate index wins, and `sqlite-vec` will
add HNSW in a future release.

## Integration

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[1536]
);

SELECT chunk_id
FROM vec_chunks
WHERE embedding MATCH ?
  AND k = 20
ORDER BY distance;
```

Lumen loads the extension lazily — if the native binary is missing, vector
search is silently disabled and the hybrid retriever falls back to BM25 +
TF-IDF only. Embedding provider is configurable (see embedding.md).
