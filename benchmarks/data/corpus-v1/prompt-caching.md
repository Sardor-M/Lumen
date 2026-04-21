# Prompt Caching

Prompt caching lets an LLM provider skip redundant compute when the same
prefix is sent across multiple requests. Anthropic's implementation stores
tokenized-and-embedded prefixes for up to 5 minutes at a lower rate;
OpenAI offers similar caching on long inputs.

## When it pays

Prompt caching pays off when the same large prefix (system prompt, tool
definitions, fetched documents) is reused across short turns. A cached
prefix is ~10× cheaper and ~2× faster than a fresh request of the same
size.

## Pitfalls

- **5-minute TTL**: if your application pauses between requests longer
  than 5 minutes, the cache expires and the next call pays full price.
- **Order-sensitive**: the cache keys on exact token sequences from the
  start of the prompt. Inserting anything into the prefix invalidates
  every cached version downstream.
- **Size thresholds**: small prompts (below ~1K tokens for Anthropic)
  don't cache — the savings don't exceed the overhead.

## What it looks like in Lumen

Lumen's `ask` command sends retrieved chunks as context. Across back-to-
back queries in the same session, the tool definitions and system prompt
are stable, so caching halves the effective cost. The retrieved chunks
themselves differ per query and never cache.

See rag.md for the broader pipeline this optimizes.
