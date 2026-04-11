import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import * as log from '../utils/logger.js';

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

/** Content for the Claude Code skill file. */
function skillContent(): string {
    return `---
name: lumen
description: Search and query your personal knowledge base
triggers:
  - /lumen
---

# Lumen Knowledge Base

You have access to a Lumen knowledge base via MCP tools. Use these tools to help the user:

## Available MCP Tools

- **search** — Hybrid BM25 + TF-IDF search across all ingested content
- **query** — Ask a question and get a synthesized answer using search + LLM
- **status** — Show knowledge base statistics
- **god_nodes** — Return the most connected concepts (highest connectivity)
- **concept** — Get details about a specific concept including edges and sources
- **path** — Find the shortest path between two concepts
- **neighbors** — Get all concepts within N hops of a given concept
- **pagerank** — Return concepts ranked by PageRank importance
- **communities** — List detected concept communities (topic clusters)
- **community** — Get concepts in a specific community by ID
- **add** — Ingest a new source (URL, file, arXiv, YouTube)

## Usage

When the user invokes /lumen, determine what they need:
- For search queries: use the \`search\` tool
- For questions: use the \`query\` tool
- For graph exploration: use \`god_nodes\`, \`concept\`, \`path\`, \`neighbors\`, \`communities\`
- For ingesting new content: use the \`add\` tool
- For overview: use \`status\`
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
        .description('Set up Lumen integration for a platform (claude, codex)')
        .action((platform: string) => {
            try {
                const cwd = process.cwd();

                switch (platform) {
                    case 'claude':
                        installClaude(cwd);
                        break;
                    case 'codex':
                        installCodex(cwd);
                        break;
                    default:
                        log.error(`Unknown platform: "${platform}". Supported: claude, codex`);
                        process.exitCode = 1;
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
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

    /** 4. Write .claude/settings.json with hook config */
    const settingsDir = join(cwd, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');
    const hookConfig = {
        hooks: {
            PreToolUse: [
                {
                    matcher: 'Glob|Grep',
                    command: join('.claude', 'hooks', 'lumen-pretool.sh'),
                },
            ],
        },
    };

    if (existsSync(settingsPath)) {
        const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (
            !existing.hooks?.PreToolUse?.some((h: { command: string }) =>
                h.command.includes('lumen'),
            )
        ) {
            existing.hooks = existing.hooks ?? {};
            existing.hooks.PreToolUse = [
                ...(existing.hooks.PreToolUse ?? []),
                ...hookConfig.hooks.PreToolUse,
            ];
            writeFileSync(settingsPath, JSON.stringify(existing, null, 4) + '\n', 'utf-8');
            log.success('Updated .claude/settings.json with PreToolUse hook');
            created++;
        } else {
            log.dim('.claude/settings.json already has lumen hook');
        }
    } else {
        writeFileSync(settingsPath, JSON.stringify(hookConfig, null, 4) + '\n', 'utf-8');
        log.success('Created .claude/settings.json with PreToolUse hook');
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
