import type { Command } from 'commander';
import ora from 'ora';
import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { getDb } from '../store/database.js';
import { getSource } from '../store/sources.js';
import { chatAnthropicStream } from '../llm/client.js';
import { QA_SYSTEM, qaUserPrompt } from '../llm/prompts/qa.js';
import { loadConfig } from '../utils/config.js';
import * as log from '../utils/logger.js';

export function registerAsk(program: Command): void {
    program
        .command('ask <question>')
        .description(
            'Ask a question — search locally, send top chunks to LLM, get a synthesized answer',
        )
        .option('-n, --limit <n>', 'Max chunks to retrieve', '10')
        .option('-b, --budget <tokens>', 'Token budget for context', '4000')
        .action(async (question: string, opts: { limit: string; budget: string }) => {
            try {
                const config = loadConfig();
                getDb();
                const limit = parseInt(opts.limit) || 10;
                const budget = parseInt(opts.budget) || config.search.token_budget;

                const spinner = ora('Searching knowledge base...').start();

                const bm25 = searchBm25(question, limit * 2);
                const tfidf = searchTfIdf(question, limit * 2);

                const fused = fuseRrf(
                    [
                        {
                            name: 'bm25',
                            weight: 0.5,
                            results: bm25.map((r) => ({
                                chunk_id: r.chunk_id,
                                source_id: r.source_id,
                                score: r.score,
                            })),
                        },
                        {
                            name: 'tfidf',
                            weight: 0.5,
                            results: tfidf.map((r) => ({
                                chunk_id: r.chunk_id,
                                source_id: r.source_id,
                                score: r.score,
                            })),
                        },
                    ],
                    60,
                );

                const selected = selectByBudget(
                    fused.slice(0, limit).map((r) => ({
                        chunk_id: r.chunk_id,
                        source_id: r.source_id,
                        score: r.rrf_score,
                    })),
                    budget,
                );

                if (selected.length === 0) {
                    spinner.fail('No relevant content found');
                    log.dim('Try ingesting more sources with: lumen add <url>');
                    return;
                }

                spinner.text = `Synthesizing answer from ${selected.length} chunks...`;

                const chunks = selected.map((c) => ({
                    source_title: getSource(c.source_id)?.title ?? c.source_id,
                    heading: null as string | null,
                    content: c.content,
                    score: c.score,
                }));

                spinner.stop();

                /** Print the heading on first token so a pre-stream error surfaces cleanly. */
                let headingPrinted = false;
                await chatAnthropicStream(
                    config,
                    [{ role: 'user', content: qaUserPrompt(question, chunks) }],
                    {
                        system: QA_SYSTEM,
                        maxTokens: 2048,
                        onToken: (token) => {
                            if (!headingPrinted) {
                                log.heading('Answer');
                                headingPrinted = true;
                            }
                            process.stdout.write(token);
                        },
                    },
                );

                process.stdout.write('\n\n');
                log.dim(`Sources: ${[...new Set(chunks.map((c) => c.source_title))].join(', ')}`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
