#!/usr/bin/env node
import { Command } from 'commander';
import { registerAdd } from './commands/add.js';
import { registerSearch } from './commands/search.js';

const program = new Command();

program
    .name('lumen')
    .description(
        'Intelligent knowledge compiler — ingest, chunk, search, and compile any reading into a structured knowledge graph',
    )
    .version('0.1.0');

registerAdd(program);
registerSearch(program);

program.parse();
