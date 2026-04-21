# Embeddings

Embeddings map text to dense vectors in a high-dimensional space where
semantically similar text lies close together. They enable semantic search
(see vector-search.md) — matching by meaning rather than literal term overlap.

## Models

- **OpenAI text-embedding-3-small**: 1536 dimensions, general-purpose,
  covers most retrieval tasks well.
- **text-embedding-3-large**: 3072 dimensions, higher quality, 5× the cost.
- **Sentence-BERT (MiniLM, MPNet)**: open-source, 384–768 dimensions,
  run locally.
- **Nomic, BGE, E5**: newer open models competitive with OpenAI on MTEB.

## Distance metrics

Cosine similarity is most common. L2 (Euclidean) and dot product also work
if the embedding model was trained to be length-normalized. Lumen's vector
store uses cosine via `sqlite-vec`.

## Cost and caching

Embedding every chunk of every ingested document costs real money or local
GPU time. Lumen caches embeddings indexed by `(content_hash, model)` so
re-ingesting the same chunk with the same model is free. Changing the model
invalidates the cache.

## Chunk size interaction

Most embedding models were trained on short inputs (128–512 tokens). Feeding
a 2000-token chunk reduces quality — the model averages over too much. See
chunking.md for how Lumen bounds chunk sizes.
