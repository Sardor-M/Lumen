---
name: deploy-check
description: Pre-deploy verification for Lumen monorepo — type check, lint, test, build across all workspaces. TRIGGER when user says deploy, ship, release, pre-merge, or CI check.
---

# Lumen Deploy Check

Full verification across the monorepo before merging or deploying.

## Steps

1. **Type check CLI**: `pnpm --filter lumen-kb lint`
2. **Tests**: `pnpm --filter lumen-kb test`
3. **Web build** (if Node ≤22): `pnpm --filter @lumen/web build`
4. **Web lint** (if Node 23+): `pnpm --filter @lumen/web lint` (build crashes on Node 23 due to webpack WASM hash — see gotchas)
5. **Git status**: Verify no uncommitted changes leaked

## Gotchas

- `next build` crashes on Node 23 with `TypeError: The "data" argument must be of type string`. This is a known webpack WASM hash bug. Use `next dev` for development. Production builds require Node 22 LTS.
- `better-sqlite3` needs its native binding compiled. If you see `MODULE_NOT_FOUND`, run `pnpm rebuild better-sqlite3`.
- The monorepo uses `node-linker=hoisted` + `shamefully-hoist=true` in `.npmrc` because iCloud syncs `node_modules` in `~/Desktop/` and corrupts pnpm symlinks. If modules go missing, re-run `pnpm install`.
- `node_modules` dirs are symlinked to `/tmp/lumen-*/node_modules`. After reboot, `/tmp` is cleared — you'll need to recreate symlinks and reinstall.

## Output

Report one line per step: `PASS` or `FAIL` with error summary.
