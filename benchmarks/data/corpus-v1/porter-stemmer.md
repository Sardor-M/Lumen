# Porter Stemmer

The Porter stemming algorithm, published by Martin Porter in 1980, reduces
English words to a common stem by applying a sequence of suffix-stripping
rules. It treats "connect", "connected", "connecting", and "connection"
as forms of the same root, improving recall in keyword retrievers.

## Why it's good enough

Porter is not a real morphological analyzer — it does not know that "saw"
is the past tense of "see". It just strips suffixes by rule. Modern
retrievers have better options (lemmatizers, subword tokenizers) but Porter
has two properties that keep it alive 45 years after publication: it's
fast and it's deterministic. No model to ship. No ambiguity to resolve.

## In SQLite FTS5

FTS5 ships Porter as one of three built-in tokenizers. Typical setup stacks
it with unicode61 to handle diacritics: `tokenize='porter unicode61'`.
See sqlite-fts5.md for the full configuration.

## Known flaws

- Over-stems: "organization" and "organ" both stem to "organ".
- Under-stems: Porter misses "was" → "be".
- English-only: Porter's successors (Snowball, Lancaster) handle other
  languages with their own rule sets.

For a Lumen-style personal knowledge base with mixed-English content,
Porter's failure modes are rare and cheap to tolerate; the alternative of
shipping a multi-MB lemmatizer model is not worth the disk cost.
