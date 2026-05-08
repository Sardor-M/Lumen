# lumen-kb

Local-first knowledge compiler. Ingest articles, papers, PDFs, YouTube transcripts, code repositories, datasets (CSV / JSONL / HuggingFace), images with OCR, and Obsidian vault clippings into a searchable knowledge graph — then wire it into Claude Code, Cursor, or any MCP client. Now with **opt-in end-to-end-encrypted cross-device sync** so your knowledge base follows you across laptops.

## Install

```bash
npm install -g lumen-kb
```

## Quick start

```bash
# Set up
lumen init
echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.lumen/.env

# Ingest
lumen add https://karpathy.medium.com/software-2-0-a64152b37c35
lumen add ./papers/attention.pdf
lumen add https://www.youtube.com/watch?v=kCc8FmEb1nY
lumen add 1706.03762                                      # arXiv by ID
lumen add https://github.com/anthropics/claude-code       # whole code repo
lumen add ./data/results.csv                              # dataset
lumen add ./diagrams/architecture.png                     # image (OCR)
lumen watch add obsidian ~/ObsidianVault                  # auto-pull clippings

# Compile into knowledge graph
lumen compile -c 3

# Search (local, no LLM)
lumen search "attention mechanism" -b 4000

# Ask (LLM-synthesized, streaming)
lumen ask "How does self-attention work?"
```

## Wire into Claude Code

```bash
lumen install claude
```

One command. Generates `CLAUDE.md` (brain-first protocol), `.mcp.json`, hooks, and a skill file. Claude checks your knowledge base before answering and captures new ideas after every response.

## MCP server

```bash
lumen --mcp    # 23 tools via stdio
```

```json
{ "mcpServers": { "lumen": { "command": "lumen", "args": ["--mcp"] } } }
```

Tools: `brain_ops`, `search`, `query`, `concept`, `add_link`, `links`, `backlinks`, `god_nodes`, `pagerank`, `path`, `neighbors`, `communities`, `community`, `add`, `compile`, `capture`, `session_summary`, `brain_feedback`, `retire_skill`, `capture_trajectory`, `replay_skill`, `status`, `profile`.

## Cross-device sync (v0.2.0)

Opt-in, end-to-end-encrypted sync across your laptops. Every concept-touching mutation lands in an append-only journal, gets sealed with X25519 + XChaCha20-Poly1305 on-device, and pushes to a self-hostable Cloudflare Worker relay. The relay holds opaque ciphertext only — it never sees your master key or your concepts.

```bash
# On device A (the seeder):
lumen sync init --relay https://lumen-relay.<your-account>.workers.dev
lumen sync enable
lumen sync show-key --reveal           # copy this key into a password manager

# On device B (and C, D, …):
lumen sync import-key "<base64 key>" --relay <same URL>
lumen sync enable
lumen sync run                          # push, pull, apply in one cycle
```

The reference relay is a ~600-LOC Cloudflare Worker shipped under `apps/relay/` in the [GitHub repo](https://github.com/Sardor-M/Lumen) — deployable in three `wrangler` commands.

What syncs: concept creations, compiled-truth updates, `+1`/`-1` feedback, retirements, and replayable trajectories. What doesn't: source files (`lumen add` content), embeddings, raw chunks — those stay local-first.

## Commands

| Command          | What it does                                                                          | LLM |
| ---------------- | ------------------------------------------------------------------------------------- | --- |
| `init`           | Create `~/.lumen` workspace                                                           |     |
| `add <input>`    | Ingest URL, PDF, YouTube, arXiv, file, folder, code repo, dataset, image              |     |
| `watch`          | Manage auto-ingest connectors (folder, rss, arxiv, github, obsidian, youtube-channel) |     |
| `compile`        | Extract concepts + edges via LLM                                                      | yes |
| `search <query>` | Hybrid BM25 + TF-IDF + vector search                                                  |     |
| `ask <question>` | Streamed LLM answer from your sources                                                 | yes |
| `enrich`         | Auto-escalate concept tiers via LLM                                                   | yes |
| `embed`          | Generate vector embeddings                                                            | API |
| `graph <sub>`    | pagerank, path, neighbors, report, export                                             |     |
| `sync <sub>`     | E2E-encrypted cross-device sync — init, enable, push, pull, apply, run, status        |     |
| `profile`        | Corpus summary                                                                        |     |
| `status`         | DB statistics                                                                         |     |
| `install claude` | Wire into Claude Code                                                                 |     |
| `install codex`  | Wire into Codex                                                                       |     |

Sync subcommands: `init [--relay <url>]`, `enable`/`disable`, `push`/`pull`/`apply`/`run`, `status`, `reset-error`, `show-key [--reveal]`, `import-key <base64>`, `forget-key`.

## Cross-device sync — automatic mode

`lumen sync run` is on-demand by default. Two layers stack to make sync feel transparent across your laptops without manual commands.

### Layer 1 — auto-push after every Claude Code response

`lumen install claude` writes a Stop hook (`.claude/hooks/lumen-signal.sh`) that fires at the end of every Claude response. As of v0.2.0+, that hook runs `timeout 8 lumen sync run` first, so any concepts Claude just created (`add` + `compile`, `capture`, `brain_feedback`, `retire_skill`, `capture_trajectory`) push to the relay before the next turn.

The push is time-bounded to 8 seconds and silently no-ops when sync is disabled, no relay is configured, or the relay is unreachable — so the agent loop is never stalled by network conditions.

This covers the "push side" inside Claude sessions. It doesn't pull, and it doesn't fire when you're working from a plain terminal.

### Layer 2 — periodic background sync via launchd / systemd

For full both-direction sync regardless of whether an agent is running, drop a small unit file into your OS scheduler. Templates ship under `apps/cli/templates/` (or `<install-prefix>/lib/node_modules/lumen-kb/templates/` if you installed via `npm install -g`):

**macOS (LaunchAgent):**

```bash
# Copy + edit + load
cp <templates>/launchd/com.lumen.sync.plist.template ~/Library/LaunchAgents/com.lumen.sync.plist

# Edit the file: replace <PATH> and <HOME> with your real values, e.g.
#   PATH = /usr/local/bin:/opt/homebrew/bin:/Users/me/.npm-global/bin:/usr/bin:/bin
#   HOME = /Users/me
# (uncomment the LUMEN_KEYRING_BACKEND line + set to "file" if you bypass Keychain)

launchctl load ~/Library/LaunchAgents/com.lumen.sync.plist

# Verify it's firing
launchctl list | grep lumen
tail -f /tmp/lumen-sync.log
```

**Linux (systemd user services):**

```bash
mkdir -p ~/.config/systemd/user
cp <templates>/systemd/lumen-sync.service.template ~/.config/systemd/user/lumen-sync.service
cp <templates>/systemd/lumen-sync.timer.template   ~/.config/systemd/user/lumen-sync.timer

# Edit lumen-sync.service: replace <LUMEN_BIN> (e.g., /usr/local/bin/lumen) and <HOME>

systemctl --user daemon-reload
systemctl --user enable --now lumen-sync.timer

# Verify
systemctl --user list-timers | grep lumen-sync
journalctl --user -u lumen-sync.service -f
```

**Tunable interval** — both templates default to 120 seconds. Override:

- launchd: edit `<integer>120</integer>` under `StartInterval`
- systemd: edit `OnUnitActiveSec=120` in `lumen-sync.timer`

Recommended: **60s** for active testing, **120s** general use, **300–900s** for low-power.

**Pause / resume:**

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.lumen.sync.plist
launchctl load   ~/Library/LaunchAgents/com.lumen.sync.plist

# Linux
systemctl --user stop  lumen-sync.timer
systemctl --user start lumen-sync.timer
```

### Out of scope (Tier 6 / 0.3.0)

A first-class `lumen sync daemon install` subcommand that detects platform, generates the unit file, and handles install/uninstall/status without manual editing — that's coming in 0.3.0. For now, the templates + manual edit are the path of least resistance.

## How it works

1. **Ingest** — extract content from any source (articles, papers, video transcripts, code repos, datasets, images, Obsidian clippings), chunk structurally, deduplicate via SHA-256, index with FTS5
2. **Compile** — LLM extracts concepts + weighted edges, builds compiled truth + timeline per concept
3. **Search** — BM25 + TF-IDF + vector ANN fused via Reciprocal Rank Fusion, budget-cut by relevance density
4. **Enrich** — concepts auto-escalate from stub (Tier 3) to full knowledge page (Tier 1) as evidence grows
5. **Agent loop** — `brain_ops` checks the KB before answering, `capture` persists new ideas after responding
6. **Sync** — opt-in journal of concept-touching mutations, sealed with X25519 + XChaCha20-Poly1305, pushed to a zero-knowledge Cloudflare Worker relay

## Storage

Everything in `~/.lumen/lumen.db` — one SQLite file. Back it up and you have everything.

## Providers

- **LLM**: Anthropic (Claude), OpenRouter, Ollama
- **Embeddings**: OpenAI, Ollama
- **Default model**: `claude-sonnet-4-6`

## Links

- [npm](https://www.npmjs.com/package/lumen-kb)
- [GitHub](https://github.com/Sardor-M/Lumen)
- MIT Licensed
