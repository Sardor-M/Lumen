---
name: new-module
description: Scaffold a new Lumen module (store, ingest, search, chunker, etc.) following project patterns. TRIGGER when user asks to create, add, or scaffold a new module, extractor, or store layer.
---

# Scaffold New Lumen Module

Generate a new module following existing patterns. Follow all rules in `CLAUDE.md`.

## Before Scaffolding

1. Read `src/types/index.ts` — check if needed types already exist
2. Identify the layer:
    - `store/` — SQLite CRUD for a table (see `templates/store.ts.md`)
    - `ingest/` — content extractor for a source type (see `templates/ingest.ts.md`)
    - `search/` — search signal implementation
    - `chunker/` — format-specific chunker
    - `compress/` — compression pipeline stage
    - `graph/` — graph algorithm
    - `delta/` — change tracking
3. Check if a stub file already exists (many have placeholder comments)

## Steps

1. Add new types to `src/types/index.ts` if needed
2. Create the module following the template in `templates/`
3. If store module: add the table to `src/store/schema.ts` and bump `CURRENT_VERSION`
4. If ingest module: wire into `src/ingest/file.ts` router
5. Run `npx tsc --noEmit` to verify
6. Run `npx prettier --write` on new files
