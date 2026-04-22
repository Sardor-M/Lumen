# God Nodes

A "god node" is a concept in a knowledge graph with an unusually high number
of connecting edges — the most referenced or most-central ideas in a corpus.
They tend to be foundational concepts that many other concepts depend on.

## How Lumen surfaces them

The `god_nodes` MCP tool ranks concepts by total edge count (incoming plus
outgoing) and returns the top N. For a corpus about information retrieval,
god nodes might be "BM25", "embeddings", "retrieval-augmented generation" —
the ideas that show up in most other pages as `related-to` or `extends`
targets.

## Versus PageRank

PageRank (see pagerank.md) gives a similar but not identical signal. A god
node has many edges; a high-PageRank node has edges from OTHER high-PageRank
nodes. A concept that's mentioned casually by many isolated notes will have
high edge count but modest PageRank. Use both together when reasoning about
importance.

## Pruning

When the god-node count for a concept crosses a threshold (say 50+ edges in
a 500-concept graph), it often means the concept is too coarse and should
be split. "Software engineering" is a classic offender — it accrues edges
from almost everything. Lumen flags this with `lumen lint --coarse-concepts`.
