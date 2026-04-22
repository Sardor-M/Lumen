# PageRank

PageRank scores the importance of nodes in a directed graph by modeling a
random walker who follows outgoing edges with probability `d` and teleports
to a uniformly random node with probability `1 - d`. The stationary
distribution of this walk is the PageRank vector.

## Formula

For a graph with nodes `v_1 ... v_n`, the PageRank score of node `i` is:

```
PR(i) = (1 - d) / n + d · Σ_{j → i} PR(j) / out_degree(j)
```

with damping factor `d = 0.85` typically. The scores are computed by power
iteration until convergence.

## Dangling nodes

Nodes with no outgoing edges leak probability mass out of the graph unless
handled explicitly. Two common fixes: redistribute dangling mass uniformly
across all nodes, or add self-loops during preprocessing. Lumen's
implementation uses the redistribution strategy.

## Use in knowledge graphs

In a concept graph, PageRank identifies "god nodes" (see god-nodes.md) —
concepts that many other concepts reference or depend on. These tend to be
foundational ideas in the corpus. PageRank complements community detection
(see community-detection.md) by giving a per-node importance signal on top
of the clustering.
