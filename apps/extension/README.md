# @lumen/extension

Browser extension for one-click ingestion of the current tab into your Lumen knowledge base.

## Status

Scaffolded. Not implemented yet. This is a placeholder for future work.

## Planned features

- One-click "Add to Lumen" button on any page
- Highlight selection → save as annotation
- Background script to auto-suggest ingest when you spend significant time on a page
- Local-only — talks to `lumen --mcp` or `lumen serve` running on localhost

## How it will work

The extension posts to a local HTTP endpoint exposed by `lumen serve` (Phase 3 web server).
No data leaves your machine.
