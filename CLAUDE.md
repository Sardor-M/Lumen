# Lumen — Project Rules

## What is Lumen

CLI-first knowledge compiler. Ingest articles/papers/videos → chunk → store in SQLite → search via BM25 → compile into knowledge graph via LLM.

## Commands

```bash
pnpm dev -- <command>       # run CLI in dev mode
pnpm lint                   # eslint + tsc --noEmit
pnpm format                 # prettier --write src/
pnpm test                   # vitest run
```

## Hard Rules

- **`type` not `interface`**. Always. No exceptions.
- **`/** JSDoc \*/`not`//`\*\*. Every comment is JSDoc style.
- **`.js` extensions** in all relative imports. ESM requires it.
- **`import type`** for type-only imports.
- **No classes**. Plain functions and types only.
- **No default exports**. Named exports everywhere.
- **No enums**. Use union types: `type Foo = 'a' | 'b' | 'c'`
- **No `any`**. Use `unknown` or specific types.
- **No `console.log` in commands**. Use `log.info/success/warn/error/heading/table/dim`.
- **No `process.exit()`**. Set `process.exitCode = 1` instead.
- **Prefix unused params** with `_`.

## File Patterns

- Types → `src/types/index.ts`
- Store CRUD → `src/store/<table>.ts` using `getDb()` singleton
- Ingest → `src/ingest/<format>.ts` returning `ExtractionResult`
- Commands → `src/commands/<name>.ts` using `registerX(program)` pattern
- All CLI commands catch errors at action boundary

## Testing

Always use `LUMEN_DIR=$(mktemp -d)` for tests to avoid writing to `~/.lumen`.

## Before Committing

Run: `npx tsc --noEmit && npx eslint src/ && npx prettier --check "src/**/*.ts"`
