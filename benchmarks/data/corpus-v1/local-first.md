# Local-First

Local-first software keeps the primary copy of user data on the user's own
device. Network connectivity enables synchronization and collaboration but
is never required to read or write. The approach trades some ambient
convenience for a step-change improvement in latency, privacy, and user
ownership.

## Principles

1. The network is optional — everything works offline.
2. Data lives where the user can see and move it (a file on disk, not a
   SaaS row behind a login).
3. Long-term access does not depend on a vendor staying in business.
4. Collaboration happens via CRDTs, git-like sync, or explicit handoff —
   not a central server.

## For knowledge tools

Most knowledge tools (Notion, Roam, Mem) store your content in a cloud
database. If the service disappears or you cancel, your notes may or may
not come with you. Local-first knowledge tools (Obsidian, Logseq, Lumen)
keep content as plain files or a local database you own.

## What Lumen chose

Lumen stores content in a SQLite database under a user-controlled directory
(default `~/.lumen/lumen.db`). The MCP server is a local binary. LLM calls
go to providers the user configures — any OpenRouter-compatible endpoint,
a local Ollama install, or Anthropic. No content leaves the machine unless
the user explicitly invokes an operation that sends it. See sqlite-fts5.md
and sqlite-vec.md for the storage substrate.
