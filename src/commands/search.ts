import type { Command } from 'commander';
import { searchBm25 } from '../search/bm25.js';
import { loadConfig } from '../utils/config.js';
import * as log from '../utils/logger.js';

export function registerSearch(program: Command): void {
    program
        .command('search <query>')
        .description('Search ingested content using BM25 full-text search (local, no LLM)')
        .option('-n, --limit <n>', 'Max results', '10')
        .action((query: string, opts: { limit: string }) => {
            try {
                const config = loadConfig();
                const limit = parseInt(opts.limit) || config.search.max_results;

                const results = searchBm25(query, limit);

                if (results.length === 0) {
                    log.warn(`No results for "${query}"`);
                    return;
                }

                log.heading(`Search results for "${query}"`);
                log.dim(`${results.length} result${results.length === 1 ? '' : 's'}\n`);

                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    const score = (r.score * 100).toFixed(0);
                    const heading = r.heading ? ` > ${r.heading}` : '';

                    console.log(`  ${i + 1}. [${score}%] ${r.source_title}${heading}`);
                    console.log(`     ${r.snippet}`);
                    console.log();
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
