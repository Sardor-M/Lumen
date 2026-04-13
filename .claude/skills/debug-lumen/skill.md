---
name: debug-lumen
description: Diagnose Lumen CLI or MCP issues — common errors, SQLite problems, search returning no results, compilation failures. TRIGGER when user reports a bug, error, or unexpected behavior.
---

# Debug Lumen

Systematic debugging for the Lumen knowledge base engine.

## Symptom → Investigation Map

| Symptom                   | First check                                                        | Then check                                                                  |
| ------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `lumen` command not found | `which lumen` → `npm link` from `apps/cli/`                        | Verify `apps/cli/dist/cli.js` exists (run `pnpm --filter @lumen/cli build`) |
| MCP server hangs          | Expected — stdio servers wait silently for JSON-RPC input          | Test with: `printf '{"jsonrpc":"2.0","id":1,...}' \| lumen --mcp`           |
| Search returns nothing    | `lumen status` — are there sources/chunks?                         | Check if FTS5 index exists: `sqlite3 ~/.lumen/lumen.db ".tables"`           |
| Compilation fails         | Check API key: `lumen config` or `echo $ANTHROPIC_API_KEY`         | Check source has chunks: `lumen status`                                     |
| `MODULE_NOT_FOUND` errors | `pnpm install` then `pnpm rebuild better-sqlite3`                  | Check if `/tmp/lumen-*/node_modules` symlinks exist                         |
| Auth "Invalid origin"     | Add the dev port to `trustedOrigins` in `apps/web/src/lib/auth.ts` | Check `baseURL` matches actual URL                                          |
| Web build crashes Node 23 | Known webpack WASM hash bug — use `next dev` instead               | Or install Node 22 LTS for production builds                                |

## Quick Health Check

```bash
lumen status --json          # DB accessible? Has data?
lumen search "test" 2>&1     # Search working?
echo '{}' | lumen --mcp      # MCP process starts?
```

## Gotchas

- `LUMEN_DIR` env var overrides `~/.lumen` — check if it's set in your shell
- `resetDataDir()` must be called between vitest tests or the singleton leaks
- FTS5 terms with hyphens must be quoted: `"self-attention"` not `self-attention`
- `contentHash()` normalizes whitespace before hashing — use it for dedup, not raw `sha256()`
- `better-sqlite3` v12 requires a native binary rebuild after Node major version changes
