#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerInit } from './commands/init.js';
import { registerAdd } from './commands/add.js';
import { registerSearch } from './commands/search.js';
import { registerStatus } from './commands/status.js';
import { registerCompile } from './commands/compile.js';
import { registerGraph } from './commands/graph.js';
import { registerInstall } from './commands/install.js';
import { registerAsk } from './commands/ask.js';
import { registerProfile } from './commands/profile.js';
import { registerMemory } from './commands/memory.js';
import { registerServe } from './commands/serve.js';

/** Load .env before any command runs — the globally-installed bin won't pick up
 *  a project .env automatically. Precedence: $PWD/.env (dev override) over
 *  $LUMEN_DIR/.env (persistent user config). */
function loadEnvFiles(): void {
    const lumenDir = process.env.LUMEN_DIR || join(homedir(), '.lumen');
    const candidates = [join(lumenDir, '.env'), join(process.cwd(), '.env')];
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            process.loadEnvFile(p);
        } catch {
            /** Ignore unreadable or malformed .env files. */
        }
    }
}

loadEnvFiles();

/** MCP mode: if --mcp flag is passed, start the MCP server instead of CLI. */
if (process.argv.includes('--mcp')) {
    import('./mcp/server.js').then((m) => m.startMcpServer());
} else {
    const program = new Command();

    program
        .name('lumen')
        .description(
            'Intelligent knowledge compiler — ingest, chunk, search, and compile any reading into a structured knowledge graph',
        )
        .version('0.1.0');

    registerInit(program);
    registerAdd(program);
    registerSearch(program);
    registerAsk(program);
    registerCompile(program);
    registerGraph(program);
    registerStatus(program);
    registerProfile(program);
    registerMemory(program);
    registerServe(program);
    registerInstall(program);

    program.parse();
}
