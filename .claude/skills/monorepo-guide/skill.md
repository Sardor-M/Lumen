---
name: monorepo-guide
description: Reference for navigating the Lumen turborepo — workspace commands, where things live, cross-app imports. TRIGGER when user asks about project structure, where to put files, or how workspaces connect.
---

# Lumen Monorepo Guide

Turborepo + pnpm workspaces. Three apps, shared root config.

## Structure

```
lumen/
├── apps/
│   ├── cli/         @lumen/cli    — CLI engine + MCP server (the core product)
│   ├── web/         @lumen/web    — Next.js 15 dashboard + Better Auth
│   └── extension/   @lumen/extension — Browser extension (placeholder)
├── turbo.json       — Task pipeline (build, dev, lint, test)
├── pnpm-workspace.yaml
├── .npmrc           — node-linker=hoisted, shamefully-hoist=true
└── package.json     — Root workspace (turbo, prettier, husky)
```

## Common Commands

| What             | Command                                     |
| ---------------- | ------------------------------------------- |
| Build everything | `pnpm build`                                |
| Dev all apps     | `pnpm dev`                                  |
| CLI only dev     | `pnpm --filter @lumen/cli dev -- <command>` |
| Web only dev     | `pnpm --filter @lumen/web dev`              |
| Build CLI        | `pnpm --filter @lumen/cli build`            |
| Lint all         | `pnpm lint`                                 |
| Test CLI         | `pnpm --filter @lumen/cli test`             |
| Add dep to CLI   | `pnpm --filter @lumen/cli add <pkg>`        |
| Add dep to web   | `pnpm --filter @lumen/web add <pkg>`        |

## Cross-App Imports

`@lumen/web` depends on `@lumen/cli` via `"@lumen/cli": "workspace:*"`. This allows the web app to import engine functions directly:

```typescript
import { searchBm25 } from '@lumen/cli/src/search/bm25.js';
```

This is not wired up yet — currently the web app is UI-only. Phase 6 (Library) will make `@lumen/cli` properly exportable.

## Gotchas

- `node_modules` dirs are symlinks to `/tmp/lumen-*/node_modules` (iCloud workaround)
- After reboot or `pnpm install` failure, recreate symlinks — see CLAUDE.md
- `pnpm build` runs `turbo build` which builds CLI first (it's a dependency of web)
- `next build` crashes on Node 23 — use `next dev` or Node 22
- `better-sqlite3` native binary must be rebuilt after Node upgrades: `pnpm rebuild better-sqlite3`
- Global `lumen` binary is linked from `apps/cli/dist/cli.js` — re-link after moving: `cd apps/cli && npm link`
