# Compilation

Compilation is the step that transforms raw chunks in Lumen's store into
a structured knowledge graph. It calls an LLM with a fixed extraction
schema and parses the output into concepts, edges, and timeline entries.

## Input

The compiler samples representative chunks from a source — typically the
first N chunks, filtered to skip headings-only and boilerplate. The sample
plus the source title and type goes into the prompt. This keeps the LLM
call bounded even for very long sources.

## Output schema

The LLM returns JSON matching:

```json
{
    "concepts": [{ "slug": "bm25", "name": "BM25", "compiled_truth": "..." }],
    "edges": [{ "from": "lumen", "to": "bm25", "relation": "implements" }],
    "timeline": [{ "date": "2025-03-14", "event": "Lumen v0.1 ships BM25 via FTS5" }]
}
```

Relations are a closed set (see knowledge-graph.md).

## Idempotency

Re-compiling the same source is safe. Concepts upsert by slug (the
`compiled_truth` is overwritten with the latest synthesis); edges upsert
by `(from, to, relation)`; timeline entries dedupe on `(source_id, date,
event)`.

## Cost

Each compile is one LLM call per source. For a 100-source corpus with
Sonnet 4.6, the one-time compile bill is ~$0.10–$0.50. Incremental compiles
as sources are added cost fractions of a cent.
