---
name: code-review
description: Review changed code for Lumen project conventions — catches gotchas that linters miss like wrong hash function, FTS5 quoting, missing .js extensions, interface instead of type. TRIGGER when user asks to review, check, or audit code they wrote.
---

# Lumen Code Review

Review changed files against the project rules in `CLAUDE.md` and the codebase-specific pitfalls in `references/gotchas.md`.

## Steps

1. Run `pnpm lint` and `npx prettier --check "src/**/*.ts"` to catch automated issues
2. Read each changed file and check against `CLAUDE.md` rules and `references/gotchas.md`
3. Report findings grouped by severity: **must fix**, **should fix**, **nit**

Focus on things linters cannot catch: wrong hash function for dedup, unquoted FTS5 terms, missing transaction for batch inserts, Commander async without try/catch, singleton state leaks in tests.

## Output

```
[must fix|should fix|nit] file:line — description
```

Fix **must fix** and **should fix** automatically. Ask before fixing nits.

If more than 5 files, spawn a subagent for the review and implement fixes based on its findings.
