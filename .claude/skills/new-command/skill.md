---
name: new-command
description: Scaffold a new Lumen CLI command following the Commander.js register pattern. TRIGGER when user asks to create, add, or implement a new CLI command or subcommand.
---

# Scaffold New Lumen CLI Command

Lumen is CLI-first. Every feature starts as a CLI command. Follow all rules in `CLAUDE.md`.

## Before Scaffolding

1. Check `src/cli.ts` for already-registered commands
2. Check if a stub exists in `src/commands/`
3. Decide: does this command need LLM? If no, it must work fully offline

## Steps

1. Create or edit `src/commands/<name>.ts` using `templates/command.ts.md`
2. Register in `src/cli.ts`:
    ```typescript
    import { registerX } from './commands/x.js';
    registerX(program);
    ```
3. Run `npx tsc --noEmit` to verify
4. Test: `LUMEN_DIR=$(mktemp -d) npx tsx src/cli.ts <command> <args>`

## Command-Specific Rules

- Every command needs `.description()` for `--help`
- Async actions must wrap in try/catch — Commander does not handle rejections
- Use `audit()` for operations that change state (add, compile, delete)
- Use `loadConfig()` for settings, `getDb()` for database — both auto-initialize
