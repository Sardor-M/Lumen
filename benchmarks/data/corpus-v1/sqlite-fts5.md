# SQLite FTS5

FTS5 is SQLite's fifth-generation full-text search module. It provides an
efficient inverted index with configurable tokenizers, prefix indexing, and
built-in BM25 ranking via the `rank` column.

## Virtual table setup

An FTS5 table is a virtual table mirroring the searchable columns of a base
table. Triggers keep them in sync on insert/update/delete:

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);
```

## Ranking

The `rank` column in FTS5 exposes BM25 scores. Values are negative — more
negative means more relevant. To normalize to `[0, 1]`, compute
`(rank - min_rank) / (max_rank - min_rank)` across the returned rows.

## Tokenizers

FTS5 ships with `unicode61` (case-folding and diacritic stripping), `porter`
(stems English morphology), and `ascii`. They can be stacked: `porter
unicode61` applies Porter stemming after Unicode normalization.

## Quirks

- Hyphens and special characters are interpreted as operators unless quoted
  — `"deep-learning"` works, `deep-learning` does not.
- The `MATCH` operator expects FTS5 syntax, not LIKE patterns.

See bm25.md for the scoring formula FTS5 uses.
