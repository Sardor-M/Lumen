# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

If you discover a security vulnerability, please report it privately:

**Email:** sardor0968@gmail.com

Do **not** open a public GitHub issue for security vulnerabilities.

You should receive a response within 48 hours. If the vulnerability is confirmed, a fix will be released as a patch version and credited in the changelog (unless you prefer to remain anonymous).

## Scope

Lumen runs locally — all data stays in `~/.lumen/lumen.db` on your machine. The attack surface is limited to:

- **API key handling** — keys stored in `~/.lumen/.env`, never logged or transmitted beyond the configured LLM provider
- **URL ingestion** — `lumen add <url>` fetches external URLs; malicious content could exploit the extraction pipeline
- **MCP server** — `lumen --mcp` exposes tools over stdio; only the connected MCP client can call them
- **Web UI** — `lumen serve` starts a local Next.js server; not intended for public exposure

## What is NOT in scope

- Vulnerabilities in upstream dependencies (report those to the respective projects)
- Issues requiring physical access to the machine
- Social engineering
