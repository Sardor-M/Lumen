import type { Command } from 'commander';
import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { getDb } from '../store/database.js';
import { loadConfig } from '../utils/config.js';
import * as log from '../utils/logger.js';

export function registerSearch(program: Command): void {
    program
        .command('search <query>')
        .description('Hybrid search via BM25 + TF-IDF with RRF fusion (local, no LLM)')
        .option('-n, --limit <n>', 'Max results', '10')
        .option('--bm25-only', 'Use only BM25 (skip TF-IDF)')
        .action((query: string, opts: { limit: string; bm25Only?: boolean }) => {
            try {
                const config = loadConfig();
                getDb();
                const limit = parseInt(opts.limit) || config.search.max_results;

                if (opts.bm25Only) {
                    const results = searchBm25(query, limit);
                    printResults(query, results, 'BM25');
                    return;
                }

                /** Run both signals and fuse with RRF. */
                const bm25Results = searchBm25(query, limit * 2);
                const tfidfResults = searchTfIdf(query, limit * 2);

                const fused = fuseRrf(
                    [
                        {
                            name: 'bm25',
                            weight: 0.5,
                            results: bm25Results.map((r) => ({
                                chunk_id: r.chunk_id,
                                source_id: r.source_id,
                                score: r.score,
                            })),
                        },
                        {
                            name: 'tfidf',
                            weight: 0.5,
                            results: tfidfResults.map((r) => ({
                                chunk_id: r.chunk_id,
                                source_id: r.source_id,
                                score: r.score,
                            })),
                        },
                    ],
                    60,
                );

                if (fused.length === 0) {
                    log.warn(`No results for "${query}"`);
                    return;
                }

                /** Resolve source titles and headings for display. */
                const db = getDb();
                const limited = fused.slice(0, limit);

                log.heading(`Search results for "${query}"`);
                log.dim(
                    `${limited.length} result${limited.length === 1 ? '' : 's'} (BM25 + TF-IDF fusion)\n`,
                );

                for (let i = 0; i < limited.length; i++) {
                    const r = limited[i];
                    const chunk = db
                        .prepare('SELECT content, heading FROM chunks WHERE id = ?')
                        .get(r.chunk_id) as
                        | {
                              content: string;
                              heading: string | null;
                          }
                        | undefined;
                    const source = db
                        .prepare('SELECT title FROM sources WHERE id = ?')
                        .get(r.source_id) as
                        | {
                              title: string;
                          }
                        | undefined;

                    const title = source?.title ?? r.source_id;
                    const heading = chunk?.heading ? ` > ${chunk.heading}` : '';
                    const snippet = makeSnippet(chunk?.content ?? '', query);
                    const score = (r.rrf_score * 1000).toFixed(1);

                    console.log(`  ${i + 1}. [${score}] ${title}${heading}`);
                    console.log(`     ${snippet}`);
                    console.log();
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function printResults(
    query: string,
    results: { source_title: string; heading: string | null; snippet: string; score: number }[],
    mode: string,
): void {
    if (results.length === 0) {
        log.warn(`No results for "${query}"`);
        return;
    }

    log.heading(`Search results for "${query}"`);
    log.dim(`${results.length} result${results.length === 1 ? '' : 's'} (${mode})\n`);

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const score = (r.score * 100).toFixed(0);
        const heading = r.heading ? ` > ${r.heading}` : '';

        console.log(`  ${i + 1}. [${score}%] ${r.source_title}${heading}`);
        console.log(`     ${r.snippet}`);
        console.log();
    }
}

function makeSnippet(content: string, query: string): string {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lower = content.toLowerCase();
    let bestIdx = -1;

    for (const term of terms) {
        const idx = lower.indexOf(term);
        if (idx !== -1) {
            bestIdx = idx;
            break;
        }
    }

    if (bestIdx === -1) return content.slice(0, 200);

    const start = Math.max(0, bestIdx - 80);
    const end = Math.min(content.length, bestIdx + 120);
    let snippet = content.slice(start, end).replace(/\n/g, ' ');

    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
}
