# Markdown Parsing

Lumen's chunker treats markdown specially — headings, code fences, lists,
and tables are all structural elements that map directly to retrievable
units. Parsing markdown beats treating it as plain text because the natural
boundaries of the document are already there.

## Pipeline

1. Split frontmatter from body. YAML frontmatter between `---` lines
   becomes its own `frontmatter` chunk.
2. Tokenize the body into blocks: headings (`#`..`######`), paragraphs,
   code fences (```), blockquotes (>), list items (-, \*, N.), tables (|...|).
3. Group blocks under the closest preceding heading so the `heading` field
   of each chunk captures context.
4. Apply size bounds: split paragraphs that exceed max_tokens, merge
   adjacent small blocks that fall under min_tokens.

## Code fences

Code blocks are never split mid-line and never merged into surrounding prose.
They become their own `code` chunks with the fenced language captured as
metadata. This matters for search — code tokens ("useState", "O(n log n)")
tokenize very differently from prose.

## Why format detection matters

Some ingested URLs return HTML that happens to have markdown syntax in it;
some local files are pure plain text. Lumen runs `detectFormat()` first
(see chunking.md) and only reaches the markdown chunker when markers are
found (headings, code fences, or a frontmatter delimiter).
