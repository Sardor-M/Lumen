# Chunking

Chunking splits long documents into smaller retrievable units. Retrieval
quality, embedding cost, and context-window usage all depend on the chunking
strategy.

## Strategies

- **Fixed-size**: split every N tokens, optionally with overlap. Simple but
  ignores structure; a chunk can end mid-sentence.
- **Semantic**: split on sentence, paragraph, or section boundaries. Uses
  natural structure but chunks vary in size.
- **Structural (format-aware)**: parse the source format first (markdown,
  HTML, PDF) and split along its structure — headings, code fences, list
  items.

Lumen uses a format-aware strategy (see chunking.md, markdown-parsing.md)
with token-count bounds: chunks between 50 and 1000 tokens, with headings
always starting a new chunk.

## Overlap

Some chunkers include an overlap window (e.g. 50 tokens of the previous chunk
repeated at the start of each chunk) to keep context across boundaries. This
trades storage for recall on queries that land near a boundary.

## Trade-offs

Smaller chunks give finer retrieval but may drop context. Larger chunks
preserve context but can bury the relevant passage in noise, which hurts
re-ranking. A common sweet spot is 200–500 tokens.

See embedding.md for how chunk size interacts with embedding models.
