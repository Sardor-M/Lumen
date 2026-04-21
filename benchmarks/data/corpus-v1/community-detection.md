# Community Detection

Community detection algorithms partition a graph into groups such that nodes
within a group are densely connected and nodes across groups are sparsely
connected. Applied to a concept graph, they find topic clusters.

## Label Propagation

The algorithm Lumen uses. Each node starts with its own label, then iteratively
adopts the most common label among its neighbors. Convergence is fast — near
linear time in the number of edges — and the algorithm needs no parameters.

Reference: Raghavan, Albert & Kumara, "Near linear time algorithm to detect
community structures in large-scale networks", 2007.

## Alternatives

- **Louvain**: maximizes modularity via greedy agglomeration. Produces a
  hierarchy of communities at different resolutions. Higher quality but
  slower than label propagation.
- **Leiden**: improves on Louvain by guaranteeing connected communities.
- **Spectral clustering**: eigenvectors of the Laplacian. High quality on
  small graphs, does not scale past ~10K nodes.

## Why Label Propagation for Lumen

Personal knowledge graphs tend to be small (hundreds to low thousands of
concepts) and evolve continuously. Label propagation re-runs cheaply on
every update. The output quality is slightly below Louvain but the speed and
simplicity outweigh that tradeoff for an interactive tool.

Communities surface in the `communities` MCP tool — they give the user a
bird's-eye view of the topics their ingested corpus covers.
