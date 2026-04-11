#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerAdd } from './commands/add.js';
import { registerSearch } from './commands/search.js';
import { registerStatus } from './commands/status.js';
import { registerCompile } from './commands/compile.js';
import { registerGraph } from './commands/graph.js';
import { registerInstall } from './commands/install.js';

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
    registerCompile(program);
    registerGraph(program);
    registerStatus(program);
    registerInstall(program);

    program.parse();
}
