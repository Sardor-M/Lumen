import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { listSources } from '../store/sources.js';
import { compileSource } from '../llm/compiler.js';
import { generateReport } from '../graph/report.js';
import { updateEnrichmentTiers } from '../enrich/index.js';
import { loadConfig } from '../utils/config.js';
import { audit } from '../utils/logger.js';
import * as log from '../utils/logger.js';

export function registerCompile(program: Command): void {
    program
        .command('compile')
        .description('Compile unprocessed sources into concepts and edges via LLM')
        .option('--all', 'Recompile all sources, not just unprocessed')
        .option('-c, --concurrency <n>', 'Number of sources to compile in parallel', '3')
        .option('--model <model>', 'Override LLM model (e.g. claude-haiku-4-5-20251001 for speed)')
        .option('--report', 'Generate GRAPH_REPORT.md after compilation', true)
        .action(
            async (opts: {
                all?: boolean;
                concurrency: string;
                model?: string;
                report?: boolean;
            }) => {
                try {
                    const config = loadConfig();
                    getDb();

                    if (!config.llm.api_key) {
                        log.error(
                            'No API key configured. Set ANTHROPIC_API_KEY or run: lumen config --api-key <key>',
                        );
                        process.exitCode = 1;
                        return;
                    }

                    const sources = opts.all ? listSources() : listSources({ compiled: false });

                    if (sources.length === 0) {
                        log.info('No uncompiled sources. Use --all to recompile everything.');
                        return;
                    }

                    /** Override model before any LLM calls. */
                    if (opts.model) {
                        config.llm.model = opts.model;
                    }

                    /** Cap workers to actual source count to avoid empty workers. */
                    const concurrency = Math.min(
                        Math.max(1, parseInt(opts.concurrency) || 3),
                        sources.length,
                    );

                    log.heading(
                        `Compiling ${sources.length} source${sources.length === 1 ? '' : 's'}` +
                            (concurrency > 1 ? ` (${concurrency} parallel)` : ''),
                    );

                    let totalConcepts = 0;
                    let totalEdges = 0;
                    let totalTokens = 0;

                    /** Process sources via pre-partitioned index — each worker
                     *  owns a fixed stride so no shared mutable queue is needed. */
                    const workers = Array.from({ length: concurrency }, async (_, w) => {
                        for (let i = w; i < sources.length; i += concurrency) {
                            const src = sources[i];
                            log.info(`[${i + 1}/${sources.length}] ${src.title}`);

                            try {
                                const result = await compileSource(src.id, src.title, config);

                                totalConcepts +=
                                    result.concepts_created.length + result.concepts_updated.length;
                                totalEdges += result.edges_created;
                                totalTokens += result.tokens_used;

                                log.success(
                                    `  +${result.concepts_created.length} concepts, ~${result.concepts_updated.length} updated, ${result.edges_created} edges`,
                                );
                            } catch (err) {
                                log.error(`  Failed: ${err instanceof Error ? err.message : err}`);
                            }
                        }
                    });

                    await Promise.all(workers);

                    console.log();
                    log.heading('Compilation Summary');
                    log.table({
                        Sources: sources.length,
                        Concepts: totalConcepts,
                        Edges: totalEdges,
                        'Est. tokens': totalTokens,
                    });

                    /** Update enrichment tiers based on new evidence density. */
                    const { queued } = updateEnrichmentTiers();
                    if (queued > 0) {
                        log.dim(
                            `${queued} concept${queued === 1 ? '' : 's'} queued for enrichment — run: lumen enrich`,
                        );
                    }

                    /** Generate graph report. */
                    if (opts.report !== false) {
                        try {
                            const reportPath = generateReport();
                            log.success(`Graph report: ${reportPath}`);
                        } catch (err) {
                            log.warn(
                                `Report generation failed: ${err instanceof Error ? err.message : err}`,
                            );
                        }
                    }

                    audit('compile:batch', {
                        sources: sources.length,
                        concepts: totalConcepts,
                        edges: totalEdges,
                        tokens: totalTokens,
                    });
                } catch (err) {
                    log.error(err instanceof Error ? err.message : String(err));
                    process.exitCode = 1;
                }
            },
        );
}
