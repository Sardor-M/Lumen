# Model Context Protocol (MCP)

MCP is an open protocol for connecting LLM clients to external tools and
data sources. It defines a JSON-RPC style wire format over stdio or HTTP,
with typed tool schemas, resources, and prompts. Clients like Claude Desktop
and IDE plugins can attach any MCP server without custom integration code.

## Why it matters

Before MCP, every tool-calling integration was bespoke — an agent framework
defined its own tool format, and each provider implemented it differently.
MCP standardizes the wire contract. A tool written once works across every
compatible client.

## What a Lumen MCP server exposes

Lumen's MCP server wraps the same operations the CLI uses:

- `search`, `query`, `concept`, `path`, `neighbors`
- `pagerank`, `communities`, `community`, `god_nodes`
- `add`, `compile`, `add_link`, `links`, `backlinks`
- `capture`, `session_summary`, `profile`, `status`

Each tool returns structured JSON. See hybrid-search.md for the search
internals and knowledge-graph.md for the graph ops.

## Trust model

MCP tools can be called locally (trusted) or remotely over HTTP (untrusted).
Lumen's server hardens the remote path: bounded depth for graph traversals,
clamped limits on list ops, injection-safe parameter handling, no execution
of LLM prompts under a remote request. See the operations-contract docs.
