---
name: verify
description: Run the full Lumen verification suite — type check, lint, format, and smoke test the CLI pipeline. TRIGGER when user asks to verify, test, check, or validate changes before committing.
---

# Lumen Verification

Run all checks in order. Stop on first failure.

1. **Type check**: `npx tsc --noEmit`
2. **Lint**: `npx eslint src/`
3. **Format check**: `npx prettier --check "src/**/*.ts"`
4. **Smoke test**: Run `scripts/smoke-test.sh` — ingests a test file, searches it, verifies dedup

If prettier fails, auto-fix with `npx prettier --write "src/**/*.ts"`.

If better-sqlite3 is missing its native binary: `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx node-gyp rebuild`

Report a one-line pass/fail for each step when done.
