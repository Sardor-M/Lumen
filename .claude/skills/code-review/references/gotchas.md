# Gotchas — Common Mistakes in Lumen

## Comment style

- **All comments must be JSDoc block comments**, never `//` line comments (project rule in CLAUDE.md).
- **Canonical multi-line format**:

    ```ts
    /**
     * BFS shortest path between two concepts.
     * Returns null if no path exists.
     */
    ```

    Opens with `/**` on its own line, each content line starts with `*`, closes with ` */` on its own line.

- **Single-line JSDoc** (`/** Short description. */`) is also acceptable for one-liners. Prefer the multi-line form whenever the comment spans two or more sentences or wraps across lines.
- Do NOT use `/* non-JSDoc block */` comments — always `/** ... */`.
- Do NOT use `// inline` or `// end-of-line` comments. Convert to JSDoc above the line, or delete if the comment just restates the code.

## SQLite / better-sqlite3

- **FTS5 query parsing**: Hyphens in search terms (e.g., `self-attention`) are misinterpreted as column filters. Always quote each term: `"self-attention"` not `self-attention`.
- **Type casting from rows**: SQLite returns `string` for TEXT columns, not union types. Cast explicitly: `row.chunk_type as ChunkType`.
- **Transactions for batch inserts**: Always wrap multi-row inserts in `db.transaction()`. Individual `.run()` calls in a loop without a transaction are 100x slower.
- **ON DELETE CASCADE**: requires `PRAGMA foreign_keys = ON` which is set in `database.ts`. If you open a db manually, you must set it yourself.

## Imports

- **Missing `.js` extension**: ESM requires `./foo.js` not `./foo`. TypeScript resolves `.ts` files from `.js` imports. This is the most common import error.
- **`pdf-parse` default import**: Use `import pdf from 'pdf-parse'` not `import { pdf }`.
- **`better-sqlite3` types**: Use `import type Database from 'better-sqlite3'` for type-only, `import Database from 'better-sqlite3'` for runtime.

## Content Hashing

- **Always use `contentHash()` not `sha256()` for dedup**: `contentHash()` normalizes whitespace first. Using raw `sha256()` means the same content with different whitespace gets different hashes.
- **`shortId()` is for display IDs**: 12 hex chars. Use `contentHash()` for dedup lookups.

## CLI Commands

- **Commander.js action handlers**: Async actions must catch their own errors — Commander does not handle rejected promises. Always wrap in try/catch.
- **`process.exitCode` not `process.exit()`**: Setting exitCode lets cleanup run. Calling exit() skips it.

## Chunker

- **Code blocks are atomic**: Never split a fenced code block across chunks. The placeholder pattern (`%%CODE_BLOCK_N%%`) exists for this reason.
- **Heading tracking**: `currentHeading` must persist across paragraph splits within a section. Don't reset it on each paragraph.

## Paths

- **`getDataDir()` creates the directory**: Don't call `mkdirSync` before calling it.
- **`LUMEN_DIR` env var**: Always use this in tests to avoid writing to `~/.lumen`.
- **`resetDataDir()` in tests**: Call this between tests to avoid singleton state leaking.
