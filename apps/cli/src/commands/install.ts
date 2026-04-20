import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import * as log from '../utils/logger.js';
import { installDaemonUnit, uninstallDaemonUnit } from '../daemon/install.js';

/** Content for the PreToolUse hook script. */
function hookScript(): string {
    return `#!/usr/bin/env bash
# Lumen PreToolUse hook — surfaces knowledge graph context before file searches.
# Fires on Glob and Grep tool calls in Claude Code.

TOOL_NAME="$1"

if [[ "$TOOL_NAME" == "Glob" || "$TOOL_NAME" == "Grep" ]]; then
    STATS=$(lumen status --json 2>/dev/null)
    if [[ $? -eq 0 && -n "$STATS" ]]; then
        SOURCES=$(echo "$STATS" | grep -o '"sources":[0-9]*' | cut -d: -f2)
        CONCEPTS=$(echo "$STATS" | grep -o '"concepts":[0-9]*' | cut -d: -f2)
        EDGES=$(echo "$STATS" | grep -o '"edges":[0-9]*' | cut -d: -f2)

        if [[ "$CONCEPTS" -gt 0 ]]; then
            echo "Lumen: Knowledge graph has $CONCEPTS concepts, $EDGES edges from $SOURCES sources."
            echo "Use the lumen MCP tools (search, query, god_nodes, communities) for structured lookup."
        fi
    fi
fi
`;
}

/** Content for the always-on Claude Code skill file. */
function skillContent(): string {
    return `---
name: lumen-brain
description: Always-on knowledge brain. Fires on every message to check memory first and capture new knowledge after.
triggers:
  - every message
alwaysOn: true
---

# Lumen Brain Protocol

You have a persistent knowledge brain via Lumen MCP tools.
Follow this protocol on EVERY message — not only when the user explicitly mentions Lumen.

## Step 1 — Brain-first lookup (before answering)

On every substantive question or research task:

1. Call \`brain_ops\` with the core topic of the question.
2. If results exist — use them as grounding context in your answer.
3. Say "not in your knowledge base yet" only when \`brain_ops\` returns \`found: false\`.

Never answer a knowledge question from training alone. Always check first.

Intent shortcuts — call the right tool directly:

| What the user says | Tool |
|---|---|
| "who is X" / "what is X" | \`brain_ops\` with intent \`concept\` |
| "how does X connect to Y" / "path from X to Y" | \`brain_ops\` with intent \`path\`, from + to filled |
| "what is related to X" / "neighbors of X" | \`brain_ops\` with intent \`neighborhood\` |
| "what are my main topics" / "top concepts" | \`god_nodes\` then \`communities\` |
| "add this URL / file / paper" | \`add\` — ingest immediately, no confirmation needed |
| "remember this" / "capture this" / "save this" | \`capture\` with the user's exact phrasing |

## Step 2 — Passive signal capture (after responding)

After every response where any of the following happened, call \`capture\`:

- The user stated an original idea, observation, or thesis
- You explained a non-trivial concept the user will want to recall later
- A person, project, paper, or company was mentioned with meaningful context

Rules for capture:
- Preserve the user's **exact phrasing** — do not paraphrase or improve it
- Set \`type\` to \`idea\` for original thinking, \`fact\` for external facts, \`entity_mention\` for people/companies
- Include \`related_slugs\` if you know which existing concepts this connects to

## Step 3 — End-of-session summary

When a long conversation ends (user says "thanks", "bye", or closes topic), call \`session_summary\` with:
- A brief summary of what was discussed
- All concept slugs that came up

## Tool quick reference

| Tool | When to call |
|---|---|
| \`brain_ops\` | Before answering any knowledge question |
| \`capture\` | After any response that contains new knowledge |
| \`session_summary\` | When a session ends |
| \`add\` | When user provides a URL, file, or content to ingest |
| \`search\` | Direct keyword search when brain_ops is too broad |
| \`concept\` | Get full compiled truth + timeline for a specific concept |
| \`backlinks\` | Find what else references a concept |
| \`add_link\` | Manually cross-link two concepts |
| \`neighbors\` | N-hop neighborhood around a concept |
| \`path\` | Shortest connection between two concepts |
| \`god_nodes\` | Most connected concepts — good for orientation |
| \`communities\` | Topic clusters in the knowledge graph |
| \`status\` | Show KB statistics |
`;
}

/** Content for the Stop hook — nudges Claude to capture knowledge after each response turn. */
function signalHookScript(): string {
    return `#!/usr/bin/env bash
set -euo pipefail
# Lumen Stop hook — nudges Claude to capture knowledge after each response turn.
# Fires on the Stop event (end of Claude's response).

TOOL_NAME="\${1:-}"

if [[ "$TOOL_NAME" == "Stop" ]]; then
  STATS=$(lumen status --json 2>/dev/null) || true
  CONCEPTS=$(echo "$STATS" | grep -o '"concepts":[0-9]*' | cut -d: -f2 || echo "0")
  CONCEPTS="\${CONCEPTS:-0}"

  if [[ "$CONCEPTS" -gt 0 ]]; then
    echo "Lumen brain has $CONCEPTS concepts. If this response contained new knowledge, original thinking, or notable entity mentions — call the capture MCP tool now to grow the brain before the session ends."
  else
    echo "Lumen brain is empty. If the user shared anything worth remembering, call capture to start growing the brain."
  fi
fi
`;
}

/** Content for the AGENTS.md file (Codex integration). */
function agentsMdContent(): string {
    return `# Lumen Knowledge Base

This project has a Lumen knowledge base available via MCP.

## How to use

Run \`lumen --mcp\` to start the MCP server over stdio.

## Available tools

- \`search(query, limit?, budget?)\` — Hybrid BM25 + TF-IDF search
- \`query(question)\` — Q&A with synthesized answers from the knowledge base
- \`status()\` — Knowledge base statistics
- \`god_nodes(limit?)\` — Most connected concepts
- \`concept(slug)\` — Concept detail with edges and sources
- \`path(from, to)\` — Shortest path between concepts
- \`neighbors(slug, depth?)\` — Concepts within N hops
- \`pagerank(limit?)\` — PageRank-ranked concepts
- \`communities()\` — Topic clusters
- \`community(id)\` — Concepts in a specific community
- \`add(input)\` — Ingest a new source
`;
}

/** MCP config JSON for .mcp.json. */
function mcpConfig(): { mcpServers: Record<string, unknown> } {
    return {
        mcpServers: {
            lumen: {
                command: 'lumen',
                args: ['--mcp'],
            },
        },
    };
}

export function registerInstall(program: Command): void {
    program
        .command('install <platform>')
        .description('Set up Lumen integration for a platform (claude, codex, daemon)')
        .option('--remove', 'Uninstall the integration instead of installing')
        .action((platform: string, opts: { remove?: boolean }) => {
            try {
                const cwd = process.cwd();

                switch (platform) {
                    case 'claude':
                        installClaude(cwd);
                        break;
                    case 'codex':
                        installCodex(cwd);
                        break;
                    case 'daemon':
                        if (opts.remove) runDaemonUninstall();
                        else runDaemonInstall();
                        break;
                    default:
                        log.error(
                            `Unknown platform: "${platform}". Supported: claude, codex, daemon`,
                        );
                        process.exitCode = 1;
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function runDaemonInstall(): void {
    const result = installDaemonUnit();
    const label = result.platform === 'macos' ? 'launchd plist' : 'systemd user unit';
    log.success(`Installed ${label}`);
    log.dim(`  Path       ${result.unit_path}`);
    log.dim(`  Status     ${result.already_installed ? 'replaced' : 'new'}`);
    log.dim(`  ${result.follow_up}`);
}

function runDaemonUninstall(): void {
    const result = uninstallDaemonUnit();
    const label = result.platform === 'macos' ? 'launchd plist' : 'systemd user unit';
    if (result.removed) {
        log.success(`Removed ${label}: ${result.unit_path}`);
    } else {
        log.warn(`No ${label} found at ${result.unit_path}`);
    }
}

function installClaude(cwd: string): void {
    let created = 0;

    /** 1. Write .mcp.json */
    const mcpPath = join(cwd, '.mcp.json');
    if (existsSync(mcpPath)) {
        const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        if (existing.mcpServers?.lumen) {
            log.dim('.mcp.json already has lumen configured');
        } else {
            existing.mcpServers = { ...existing.mcpServers, ...mcpConfig().mcpServers };
            writeFileSync(mcpPath, JSON.stringify(existing, null, 4) + '\n', 'utf-8');
            log.success('Updated .mcp.json with lumen server');
            created++;
        }
    } else {
        writeFileSync(mcpPath, JSON.stringify(mcpConfig(), null, 4) + '\n', 'utf-8');
        log.success('Created .mcp.json');
        created++;
    }

    /** 2. Write skill */
    const skillDir = join(cwd, '.claude', 'skills', 'lumen');
    const skillPath = join(skillDir, 'skill.md');
    if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
    }
    writeFileSync(skillPath, skillContent(), 'utf-8');
    log.success(`Created ${relative(cwd, skillPath)}`);
    created++;

    /** 3. Write PreToolUse hook script */
    const hookDir = join(cwd, '.claude', 'hooks');
    const hookPath = join(hookDir, 'lumen-pretool.sh');
    if (!existsSync(hookDir)) {
        mkdirSync(hookDir, { recursive: true });
    }
    writeFileSync(hookPath, hookScript(), { mode: 0o755 });
    log.success(`Created ${relative(cwd, hookPath)}`);
    created++;

    /** 3b. Write Stop hook script */
    const signalHookPath = join(hookDir, 'lumen-signal.sh');
    writeFileSync(signalHookPath, signalHookScript(), { mode: 0o755 });
    log.success(`Created ${relative(cwd, signalHookPath)}`);
    created++;

    /** 4. Write .claude/settings.json with both hook configs */
    const settingsDir = join(cwd, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');
    const hookConfig = {
        hooks: {
            PreToolUse: [
                {
                    matcher: 'Glob|Grep',
                    hooks: [
                        {
                            type: 'command' as const,
                            command: join('.claude', 'hooks', 'lumen-pretool.sh'),
                        },
                    ],
                },
            ],
            Stop: [
                {
                    matcher: '',
                    hooks: [
                        {
                            type: 'command' as const,
                            command: join('.claude', 'hooks', 'lumen-signal.sh'),
                        },
                    ],
                },
            ],
        },
    };

    if (existsSync(settingsPath)) {
        const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const hasLumenHook = (entries: unknown[]): boolean =>
            Array.isArray(entries) &&
            entries.some(
                (e: unknown) =>
                    typeof e === 'object' && e !== null && JSON.stringify(e).includes('lumen'),
            );
        const alreadyHasPreTool = hasLumenHook(existing.hooks?.PreToolUse ?? []);
        const alreadyHasStop = hasLumenHook(existing.hooks?.Stop ?? []);

        if (!alreadyHasPreTool || !alreadyHasStop) {
            existing.hooks = existing.hooks ?? {};
            if (!alreadyHasPreTool) {
                existing.hooks.PreToolUse = [
                    ...(existing.hooks.PreToolUse ?? []),
                    ...hookConfig.hooks.PreToolUse,
                ];
            }
            if (!alreadyHasStop) {
                existing.hooks.Stop = [...(existing.hooks.Stop ?? []), ...hookConfig.hooks.Stop];
            }
            writeFileSync(settingsPath, JSON.stringify(existing, null, 4) + '\n', 'utf-8');
            log.success('Updated .claude/settings.json with PreToolUse + Stop hooks');
            created++;
        } else {
            log.dim('.claude/settings.json already has lumen hooks');
        }
    } else {
        writeFileSync(settingsPath, JSON.stringify(hookConfig, null, 4) + '\n', 'utf-8');
        log.success('Created .claude/settings.json with PreToolUse + Stop hooks');
        created++;
    }

    log.heading('Claude Code Integration');
    log.info(`${created} files written. Restart Claude Code to activate.`);
}

function installCodex(cwd: string): void {
    const agentsPath = join(cwd, 'AGENTS.md');

    if (existsSync(agentsPath)) {
        const content = readFileSync(agentsPath, 'utf-8');
        if (content.includes('lumen')) {
            log.warn('AGENTS.md already mentions lumen');
            return;
        }
        writeFileSync(agentsPath, content + '\n' + agentsMdContent(), 'utf-8');
        log.success('Appended Lumen section to AGENTS.md');
    } else {
        writeFileSync(agentsPath, agentsMdContent(), 'utf-8');
        log.success('Created AGENTS.md with Lumen integration');
    }

    log.dim('Codex will now see Lumen tools in AGENTS.md');
}

function relative(base: string, target: string): string {
    const resolved = resolve(target);
    const baseResolved = resolve(base);
    if (resolved.startsWith(baseResolved)) {
        return resolved.slice(baseResolved.length + 1);
    }
    return resolved;
}
