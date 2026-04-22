# TF-IDF

Term Frequency–Inverse Document Frequency (TF-IDF) weights a term's importance
based on how often it appears in a document (TF) and how rare it is across the
corpus (IDF). A term that appears frequently in one document but rarely
elsewhere carries more signal than a term like "the" which appears everywhere.

## Components

- **TF(t, d)**: count of term `t` in document `d`. Sometimes log-scaled as
  `1 + log(count)` to dampen the effect of repeated terms.
- **IDF(t)**: `log(N / df(t))` where `N` is the number of documents and
  `df(t)` is how many documents contain the term.

The product `TF · IDF` gives the per-term weight. Document scoring sums the
weights of matching query terms.

## Limitations

TF-IDF does not saturate on term frequency and does not normalize by document
length, which is why BM25 (see bm25.md) has largely replaced it in modern
search engines. TF-IDF still appears in hybrid retrievers as a complementary
signal — its rankings differ enough from BM25 that fusing them via RRF
(see rrf.md) often improves end-to-end retrieval.
