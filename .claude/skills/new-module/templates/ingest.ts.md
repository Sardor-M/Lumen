# Ingest Module Template

Ingest modules extract content from a specific source type and return an `ExtractionResult`.

```typescript
import type { ExtractionResult } from '../types/index.js';

/**
 * Extract content from <source type>.
 * Brief description of the extraction strategy.
 */
export async function extractFoo(input: string): Promise<ExtractionResult> {
    /** Validate and parse the input. */
    const parsed = parseInput(input);
    if (!parsed) throw new Error(`Invalid input: ${input}`);

    /** Fetch / read the content. */
    const content = await fetchContent(parsed);
    if (!content.trim()) throw new Error(`No extractable content from: ${input}`);

    return {
        title: deriveTitle(parsed, content),
        content,
        url: parsed.url ?? null,
        source_type: 'your_type',
        language: null,
        metadata: {
            /** Source-specific metadata goes here. */
        },
    };
}
```

## Key Patterns

- Always async — even if current impl is sync, extractors may need network later
- Throw descriptive errors on failure — the CLI command catches them
- Return `ExtractionResult` — the universal extraction contract
- `metadata` is a `Record<string, unknown>` — store anything source-specific
- Wire into `src/ingest/file.ts`:
    1. Add detection logic in `detectSourceType()`
    2. Add case in `ingestInput()` switch
