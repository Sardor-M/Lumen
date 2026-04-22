# Intent Classification

Before running a full search pipeline, Lumen classifies the user's query
into one of several intents and routes to the fastest retrieval path for
that intent.

## Intents

- **entity_lookup**: "who is X", "what is X", "tell me about X". Resolves
  straight to a concept page without retrieval.
- **graph_path**: "path from X to Y", "how does X connect to Y". Runs
  shortest-path BFS on the graph (see graph-algorithms.md).
- **neighborhood**: "what is related to X", "neighbors of X". Returns an
  N-hop neighborhood.
- **temporal**: "what happened in March", "timeline of X". Queries the
  timeline tables directly.
- **originals**: "what have I said about X", "my notes on X". Filters to
  user-captured originals.
- **hybrid_search**: everything else. Full BM25 + TF-IDF + vector pipeline.

## Why route

Full hybrid search is the heaviest path — three retrievers, a fuser, and
optional LLM re-ranking. For an entity lookup it is overkill; a direct
slug-to-concept lookup returns in <1ms. Routing saves tokens and latency
on the queries where the structure of the question already says what the
system should do.

## Classifier

Lumen uses a small rule-based classifier (regex on prefixes and key verbs)
by default. Users who prefer higher accuracy can opt into an LLM-backed
classifier via config. The rule-based version is ~98% accurate on the
common patterns and free.
