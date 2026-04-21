# Graph Algorithms

Classical graph algorithms answer structural questions about relationships
that pure text search cannot. Lumen exposes four: shortest path, neighborhood,
PageRank, and community detection.

## Shortest path (BFS)

Breadth-first search finds the minimum number of edges between two nodes.
Complexity is O(V + E). Lumen caps search depth at 6 hops — beyond that the
"relationship" between two concepts is usually accidental.

Use case: "how does BM25 connect to PageRank?" — shortestPath returns the
shortest chain of intermediate concepts.

## N-hop neighborhood

Given a center concept and depth N, collect every node reachable within N
edges. Useful for answering "what's related to X?" without pulling the whole
graph.

## PageRank

See pagerank.md for the algorithm. Used to rank concepts by importance.

## Community detection

See community-detection.md. Used to cluster concepts into topic groups.

## Why BFS not Dijkstra

Lumen's edges have weights but for path queries the weight is less meaningful
than the hop count — a user asking "how does X connect to Y" wants the
simplest chain, not the highest-weighted. BFS is also faster and simpler.
