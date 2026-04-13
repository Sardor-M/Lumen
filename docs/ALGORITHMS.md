# Algorithms

Every core algorithm in Lumen is implemented from scratch (or delegates to SQLite FTS5) and documented here with academic references, implementation file, parameters, and complexity.

All file paths are relative to `apps/cli/src/`.

## Contents

1. [BM25 full-text ranking](#bm25-full-text-ranking)
2. [TF-IDF cosine similarity](#tf-idf-cosine-similarity)
3. [Graph-walk retrieval](#graph-walk-retrieval)
4. [Reciprocal Rank Fusion](#reciprocal-rank-fusion)
5. [Relevance-density budget cut](#relevance-density-budget-cut)
6. [Compression pipeline](#compression-pipeline)
7. [PageRank](#pagerank)
8. [Label-propagation community detection](#label-propagation-community-detection)
9. [Content-addressed deduplication](#content-addressed-deduplication)
10. [Markdown-aware chunking](#markdown-aware-chunking)

---

## BM25 full-text ranking

**File:** `search/bm25.ts`
**Reference:** Robertson & Zaragoza, _The Probabilistic Relevance Framework: BM25 and Beyond_, 2009.

Lumen delegates BM25 scoring to SQLite FTS5's built-in `bm25()` function — chunks live in a virtual `chunks_fts` table and are ranked via `ORDER BY rank`. FTS5's `rank` column returns negative values (more negative = more relevant); Lumen normalizes those to `[0, 1]` so the score fuses cleanly with TF-IDF and graph walk.

```
score(d) = rank_norm = (rank(d) - min_rank) / (max_rank - min_rank)
```

Query terms are quoted individually (`"term1" "term2"`) so FTS5 doesn't misinterpret operator syntax (e.g. `AND`, `OR`, `NOT`, `*`). A snippet of up to 200 characters is extracted around the first matching term.

**Complexity:** O(k log N) for top-k retrieval via FTS5's inverted index. Indexing is incremental — SQLite updates the FTS index on every `INSERT INTO chunks`.

**Why FTS5 instead of a custom BM25?** FTS5 ships with SQLite, supports stemming (Porter), tokenization, phrase queries, and prefix matching for free. Writing BM25 from scratch in TypeScript would be slower and offer no additional correctness guarantees.

---

## TF-IDF cosine similarity

**File:** `search/tfidf.ts`
**Reference:** Salton & Buckley, _Term-weighting approaches in automatic text retrieval_, Information Processing & Management 24(5), 1988.

A pure-TypeScript TF-IDF engine with an in-memory inverted index, built lazily on first search and cached until the chunk count changes.

**Term weighting** — sublinear term frequency with inverse document frequency:

```
tf(t, d)  = 1 + log(raw_freq(t, d))
idf(t)    = log(N / df(t))
weight    = tf(t, d) · idf(t)
```

**Query scoring** — cosine similarity between query and document vectors:

```
cos(q, d) = (q · d) / (‖q‖ · ‖d‖)
```

Dot products are accumulated by walking the postings list for each query term — only documents containing at least one query term are touched. Document norms are precomputed at index build. Results are sorted by cosine and truncated to `limit`.

**Tokenization** — lowercase, split on non-alphanumeric, camelCase boundary splitting (so `getUserProfile` → `get user profile`), filter tokens shorter than 2 characters.

**Complexity:**

- Index build: O(N · L) where N is chunk count, L is average chunk length.
- Query: O(Q · M) where Q is query term count, M is average posting-list length.
- Memory: O(V + N) where V is vocabulary size.

**Why custom TF-IDF when we have FTS5?** BM25 and TF-IDF surface different documents — BM25 favors exact-term matches with length normalization, TF-IDF surfaces documents with stronger semantic overlap on rarer terms. Fusing both increases recall without sacrificing precision (see RRF below).

---

## Graph-walk retrieval

**File:** `search/graph.ts`

After BM25 and TF-IDF produce ranked chunks, Lumen identifies concepts mentioned in those chunks, walks 1–2 hops on the compiled knowledge graph, and injects additional chunks anchored to neighboring concepts. This surfaces results that are structurally related but don't match any query term — e.g. a chunk about `single-agent` pipelines when the query was `agent swarm`.

**Why a graph walk, not dense embeddings?** The compiled graph already encodes semantic structure via the LLM's concept/edge extraction. Walking it is O(neighbors), and it's the signal that differentiates Lumen from a plain keyword-search tool.

---

## Reciprocal Rank Fusion

**File:** `search/fusion.ts`
**Reference:** Cormack, Clarke & Büttcher, _Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods_, SIGIR 2009.

Three ranked lists (BM25, TF-IDF, graph walk) are merged into one via weighted RRF:

```
rrf_score(d) = Σ_i  w_i / (k + rank_i(d))
```

where `k = 60` (the value recommended in the original paper) and `w_i` is the per-signal weight configured in `search/index.ts`. Rank is 1-based, so the top result of each signal contributes `w / 61`.

RRF is score-free — it only uses ranks — which makes it robust when the underlying signals use incomparable scales (FTS5 produces log-odds; cosine produces values in `[0, 1]`; graph walk produces hop counts). No normalization or calibration needed.

**Complexity:** O(Σ|L_i|) — linear in the total size of the merged lists.

---

## Relevance-density budget cut

**File:** `search/budget.ts`

After RRF fusion, Lumen must fit the top results into a caller-supplied token budget (default 4000). Rather than greedy-by-score, it sorts by **relevance density**:

```
density(d) = score(d) / token_count(d)
```

then greedily picks chunks until the budget is exhausted. A 50-token chunk with score 0.8 (density 0.016) beats a 2000-token chunk with score 0.9 (density 0.00045). The effect is that small high-value chunks surface ahead of long low-value ones — the typical failure mode of naive top-k retrieval feeding an LLM.

**Complexity:** O(N log N) for the initial sort, O(N) for the greedy fill.

**Why greedy rather than knapsack?** Knapsack is NP-hard in general but admits FPTAS. In practice the density ordering gets within a small constant factor of optimal, and N is small (hundreds, not millions) so the gap doesn't matter.

---

## Compression pipeline

**Files:** `compress/pipeline.ts`, `compress/structural.ts`, `compress/dedup.ts`, `compress/extractive.ts`

Selected chunks pass through three sequential stages before hitting the LLM. The pipeline is monotonically shrinking — each stage only removes content, never rewrites it — so attribution back to source files remains valid.

### 1. Structural preservation

**File:** `compress/structural.ts`

Preserves headings (`#`, `##`, …), code fences (```), and paragraph boundaries verbatim. Collapses long bullet and ordered lists: the first 5 items are kept; items 6–N are replaced with `... (N-5 more items omitted)`. This alone gives large reductions on documentation-heavy corpora without touching prose.

### 2. Near-duplicate removal

**File:** `compress/dedup.ts`
**Metric:** Jaccard similarity on token sets.

```
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

For each sentence, tokenize into a set of terms (min length 3, alphanumeric only). Walk sentences in order; drop any sentence whose Jaccard similarity to a previously kept sentence is ≥ 0.8. Sentences shorter than 3 tokens are always kept (they're too short to risk false positives).

**Complexity:** O(S² · T) where S is sentence count and T is avg tokens/sentence. S is small (tens, not thousands) so the quadratic is acceptable.

### 3. Extractive scoring

**File:** `compress/extractive.ts`
**Reference:** Luhn, _The Automatic Creation of Literature Abstracts_, IBM Journal 2(2), 1958.

Score each sentence by average term frequency across the chunk, with a 1.5× position boost for the first 3 and last 2 sentences (Luhn's original intuition — openings and closings carry disproportionate information). Keep the top `ceil(ratio · N)` scored sentences, default ratio 0.6, minimum 3 sentences retained. Restore original order so text reads naturally.

**Complexity:** O(N · T) for scoring, O(N log N) for the top-k selection.

---

## PageRank

**File:** `graph/pagerank.ts`
**Reference:** Page, Brin, Motwani & Winograd, _The PageRank Citation Ranking: Bringing Order to the Web_, Stanford InfoLab, 1998.

Power-iteration PageRank on the concept adjacency graph, with explicit handling for dangling nodes.

```
PR(i) = (1 - d) / N  +  d · [ Σ_j→i  PR(j) / out(j)  +  dangling / N ]
```

where `d = 0.85` (damping), `dangling = Σ PR(j)` over all nodes with zero out-links.

**Convergence:** iterate until `Σ |PR_{k+1}(i) - PR_k(i)| < 1e-6`, capped at 100 iterations. In practice most corpora converge in 20–40 iterations.

**Complexity:** O(I · (N + E)) where I is iteration count, N is node count, E is edge count.

**Used for:** identifying **god nodes** — the highest-connectivity concepts, displayed first in `lumen graph pagerank` and surfaced in the corpus profile.

---

## Label-propagation community detection

**File:** `graph/cluster.ts`
**Reference:** Raghavan, Albert & Kumara, _Near linear time algorithm to detect community structures in large-scale networks_, Physical Review E 76(3), 2007.

Each node starts with a unique label. On every iteration, nodes adopt the most frequent label among their neighbors (ties broken by first-seen). Node order is shuffled each iteration to improve convergence stability. The algorithm terminates when no labels change, or after 50 iterations.

**Complexity:** near-linear, O(I · E) in practice with I typically 5–10 on real graphs.

**Why not Louvain or Leiden?** They produce slightly cleaner communities but require modularity computation and are more expensive. Label propagation is competitive on small-to-medium concept graphs (hundreds to low thousands of nodes) and orders of magnitude simpler to implement and reason about.

---

## Content-addressed deduplication

**Files:** `chunker/index.ts`, `store/chunks.ts`
**Reference:** Quinlan & Dorward, _Venti: a new approach to archival storage_, FAST 2002.

Every chunk is hashed with SHA-256 over whitespace-normalized content before storage. The `chunks` table has a `UNIQUE(content_hash)` constraint; identical chunks from different sources collapse to one row, keyed by hash, with a many-to-many table linking chunks back to source documents.

```
content_hash = SHA-256(normalize_whitespace(chunk_content))
```

This means: the same quote appearing in five articles costs one row, not five. The same boilerplate footer across a folder of 200 files costs one row, not 200. The cost is an O(1) SQLite lookup on insert.

---

## Markdown-aware chunking

**File:** `chunker/markdown.ts`

Splits documents at **structural boundaries** rather than by character count — the former preserves the unit a reader would identify as self-contained. Rules:

- Headings (`#`, `##`, `###`) start a new chunk.
- Fenced code blocks (`…`) are kept as atomic units regardless of size.
- Lists are kept as atomic units when under the max chunk size.
- Paragraphs separated by blank lines are the default split points.
- Fragments below `min_chunk_tokens` (default 50) are merged forward.
- Chunks above `max_chunk_tokens` (default 1000) are split at sentence boundaries.

Plain-text and HTML chunkers (`chunker/plain.ts`, `chunker/html.ts`) use simpler heuristics — paragraph breaks for plain text; block-level elements for HTML — but follow the same min/max token policy.

---

## Summary table

| Algorithm                    | File                     | Reference                            | Complexity         |
| ---------------------------- | ------------------------ | ------------------------------------ | ------------------ |
| BM25 (via FTS5)              | `search/bm25.ts`         | Robertson & Zaragoza, 2009           | O(k log N)         |
| TF-IDF cosine                | `search/tfidf.ts`        | Salton & Buckley, 1988               | O(Q · M) query     |
| Reciprocal Rank Fusion       | `search/fusion.ts`       | Cormack, Clarke & Büttcher, 2009     | O(Σ\|L\|)          |
| Relevance-density budget cut | `search/budget.ts`       | —                                    | O(N log N)         |
| Structural compression       | `compress/structural.ts` | —                                    | O(N)               |
| Jaccard dedup                | `compress/dedup.ts`      | —                                    | O(S² · T)          |
| Extractive scoring           | `compress/extractive.ts` | Luhn, 1958                           | O(N · T)           |
| PageRank                     | `graph/pagerank.ts`      | Page, Brin, Motwani & Winograd, 1998 | O(I · (N + E))     |
| Label propagation            | `graph/cluster.ts`       | Raghavan, Albert & Kumara, 2007      | O(I · E) practical |
| Content-addressed dedup      | `chunker/index.ts`       | Quinlan & Dorward, 2002              | O(1) per insert    |
| Markdown chunking            | `chunker/markdown.ts`    | —                                    | O(L)               |

---

## Implementation notes

**No external ML dependencies.** All ranking, fusion, compression, and graph algorithms are pure TypeScript with no FFI beyond `better-sqlite3` (SQLite bindings). This means Lumen runs on any Node 22+ install with no CUDA, no Python, no model downloads.

**No vector database.** Lumen deliberately does _not_ use dense embeddings. The combination of BM25 + TF-IDF + graph walk covers lexical, term-weighted, and semantic-structural retrieval without the operational overhead of embedding servers, index rebuilds, or model versioning. Semantic similarity is encoded in the compiled knowledge graph — edges the LLM extracted during `compile` — and surfaced through graph walk at query time.

**Deterministic until synthesis.** Every stage except LLM synthesis is deterministic given the same inputs. `compile` and `ask` are the only non-deterministic steps, and both write full request/response logs to `audit.log` for reproducibility.
