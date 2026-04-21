# Retrieval-Augmented Generation (RAG)

RAG is a pattern for grounding LLM outputs in external documents. Instead of
relying on the model's parametric knowledge, the system retrieves relevant
passages from a corpus at query time and injects them into the prompt.
The model's answer then cites evidence that exists in the retrieval store.

## Pipeline

1. User asks a question.
2. Retriever (BM25, vector search, or hybrid) returns top-K passages.
3. Passages are formatted into a context block in the prompt.
4. LLM answers from that context, ideally citing passage IDs.

## Why it works

- Fixes hallucination on factual queries when the fact lives in the corpus.
- Updates with the corpus — no model retraining needed.
- Gives users a provenance trail: "this answer came from these passages".

## Where it fails

- Queries that require reasoning across many passages (multi-hop) can miss
  the answer unless the retriever returns all relevant passages.
- Queries where the answer depends on structure, not prose — "how does X
  relate to Y?" — are better served by graph queries (see knowledge-graph.md).
- Retrieval recall bounds the system. If BM25 misses the passage, the LLM
  cannot cite it.

Lumen combines RAG with a compiled knowledge graph: the retriever returns
passages and the graph answers structural questions directly, without the
LLM in the loop.
