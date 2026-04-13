# Lumen — Project Rules

## What is Lumen

Local-first knowledge compiler. Ingest articles/papers/videos → chunk → store in SQLite → search via BM25 → compile into knowledge graph via LLM.

## Repo structure

Monorepo with Turborepo + pnpm workspaces.

```
lumen/
├── apps/
│   ├── cli/         — The CLI and MCP server (the engine)
│   ├── web/         — Next.js 15 web UI with Better Auth + Zod
│   └── extension/   — Browser extension (placeholder)
├── docs/            — PRODUCT-ROADMAP.md, etc.
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Commands (run from repo root)

```bash
pnpm dev                          # turbo dev — runs all apps in parallel
pnpm build                        # turbo build — builds all apps
pnpm lint                         # turbo lint
pnpm test                         # turbo test
pnpm format                       # prettier on all apps
pnpm --filter @lumen/cli dev      # CLI only
pnpm --filter @lumen/web dev      # web only
pnpm --filter @lumen/web build    # web build
```

## Hard Rules (apply to all apps)

- **`type` not `interface`**. Always. No exceptions.
- **`/** JSDoc \*/`not`//`\*\*. Every comment is JSDoc style.
- **`.js` extensions** in all relative imports (in `apps/cli/`). ESM requires it.
- **`import type`** for type-only imports.
- **No classes**. Plain functions and types only.
- **No default exports** — EXCEPT in `apps/web/` for Next.js framework files (`page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`, `not-found.tsx`, `route.ts`, `next.config.ts`). Everywhere else uses named exports.
- **No enums**. Use union types: `type Foo = 'a' | 'b' | 'c'`
- **No `any`**. Use `unknown` or specific types.
- **Prefix unused params** with `_`.

## App-specific rules

### apps/cli/

- **No `console.log` in commands**. Use `log.info/success/warn/error/heading/table/dim`.
- **No `process.exit()`**. Set `process.exitCode = 1` instead.
- **`.js` extensions** in all relative imports.

### apps/web/

- **Default exports allowed** for Next.js framework files only (see list above). All library code (`src/lib/*`, `src/components/*`) uses named exports.
- **Server components by default**. Add `'use client'` only when you need interactivity.
- **Zod for input validation** — all form inputs and API route bodies go through a Zod schema in `src/lib/schemas.ts`.
- **Better Auth session check** via `auth.api.getSession({ headers: await headers() })` in server components. Redirect unauthenticated users from protected routes.
- **No `.js` extension in relative imports** — Next.js handles it.

## File Patterns

### apps/cli/

- Types → `src/types/index.ts`
- Store CRUD → `src/store/<table>.ts` using `getDb()` singleton
- Ingest → `src/ingest/<format>.ts` returning `ExtractionResult`
- Commands → `src/commands/<name>.ts` using `registerX(program)` pattern
- All CLI commands catch errors at action boundary

### apps/web/

- Pages → `src/app/<route>/page.tsx` (default export)
- Layouts → `src/app/<route>/layout.tsx` (default export)
- API routes → `src/app/api/<route>/route.ts` (named `GET`/`POST`/etc. exports)
- Server utilities → `src/lib/*.ts` (named exports, no `'use client'`)
- Client components → `src/components/*.tsx` (named exports, `'use client'` when needed)
- Shared schemas → `src/lib/schemas.ts` (Zod)

## Environment gotcha — iCloud Desktop sync

The repo lives at `~/Desktop/for_new_macbook14 2/Projects/lumen`, which is synced by iCloud. iCloud duplicates files in `node_modules/` with " 2" suffixes, corrupting pnpm symlinks.

Workaround in place: `node_modules` at every workspace is a symlink to `/tmp/lumen-*/node_modules`. Controlled by `.npmrc` with `node-linker=hoisted` + `shamefully-hoist=true`. If you see "module not found" after a fresh clone, re-run the symlink setup.

Permanent fix: move the project out of the iCloud-synced `~/Desktop/` folder.

## Testing

Always use `LUMEN_DIR=$(mktemp -d)` for tests to avoid writing to `~/.lumen`.

## Before Committing

Run: `pnpm lint && pnpm format:check` — turbo runs it across all workspaces.
