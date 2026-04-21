# Vector Search

Vector search retrieves documents by embedding similarity rather than keyword
overlap. A query is embedded to the same space as the indexed documents and
nearest neighbors are returned.

## Algorithms

- **Exact**: compute cosine similarity against every indexed vector. Works up
  to ~100K vectors, then gets slow.
- **HNSW**: Hierarchical Navigable Small World graphs — approximate nearest
  neighbor search with log-time lookups. The industry default at scale.
- **IVF**: Inverted File indexes — partition vectors into clusters, search
  only the nearest clusters.
- **Product Quantization (PQ)**: compress vectors to save memory, usually
  combined with IVF.

Lumen uses the `sqlite-vec` extension which stores vectors in a virtual table
and does exact search. For small-to-medium corpora this is fast enough; the
extension is swappable for HNSW-based stores if scale requires.

## Versus keyword search

Vector search captures paraphrases and synonyms that BM25 misses — a query
for "cars" will match documents about "automobiles". But it often underweights
exact terms an expert user specifically typed. Hybrid retrievers (see rrf.md)
combine both signals.

See embedding.md for the models that produce the vectors and rrf.md for how
Lumen fuses vector results with BM25 and TF-IDF.
