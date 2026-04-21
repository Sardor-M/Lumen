# Knowledge Graphs

A knowledge graph is a structured representation of entities and the relations
between them. Nodes are concepts, people, places, events. Edges are typed
relationships — `implements`, `extends`, `supports`, `contradicts`, and so on.

## Why build one from prose

Raw retrieval (BM25 + vectors) surfaces passages that mention a query term.
It does not answer structural questions — "what supports this claim?", "what
does this idea extend?", "which papers contradict each other?" A graph makes
those queries cheap.

## Compilation from sources

Lumen compiles a knowledge graph by running each ingested source through an
LLM with a fixed extraction schema. The LLM returns concepts (with a slug,
name, and `compiled_truth` summary) and edges between them. See compilation.md
for the prompt structure and json schema.

## Graph operations

Once the graph exists, standard graph algorithms answer structural queries:

- **Shortest path** between two concepts: see graph-algorithms.md.
- **N-hop neighborhood**: who is within 2 hops of this concept?
- **PageRank**: which concepts are most central? (see pagerank.md)
- **Community detection**: which concepts cluster together? (see
  community-detection.md)

A concept may appear in multiple sources; the graph aggregates the evidence.
Edges may be typed differently by different sources; Lumen keeps the most-
confident typing and records the rest as timeline entries.
