import type { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { getDb } from '../store/database.js';
import { isVecAvailable } from '../store/database.js';
import { embedPending, embeddingStats, resetVecTable } from '../embed/index.js';
import * as log from '../utils/logger.js';

export function registerEmbed(program: Command): void {
    program
        .command('embed')
        .description('Generate vector embeddings for chunks (enables semantic search)')
        .option('--status', 'Show embedding coverage without embedding anything')
        .option('--reset', 'Drop and recreate vec_chunks, then re-embed all chunks')
        .action(async (opts: { status?: boolean; reset?: boolean }) => {
            try {
                const config = loadConfig();
                getDb();

                if (!isVecAvailable()) {
                    log.error(
                        'sqlite-vec extension not available. Vector search is disabled on this platform.',
                    );
                    process.exitCode = 1;
                    return;
                }

                if (config.embedding.provider === 'none') {
                    log.warn(
                        'Embedding provider is "none". Configure embedding.provider in ~/.lumen/config.json:',
                    );
                    log.dim('  For OpenAI: set embedding.provider = "openai" and OPENAI_API_KEY');
                    log.dim(
                        '  For Ollama: set embedding.provider = "ollama" (ensure ollama is running)',
                    );
                    return;
                }

                if (opts.status) {
                    const stats = embeddingStats();
                    const pct =
                        stats.total > 0 ? Math.round((stats.embedded / stats.total) * 100) : 0;
                    log.heading('Embedding coverage');
                    log.table({
                        total: stats.total,
                        embedded: stats.embedded,
                        pending: stats.pending,
                        coverage: `${pct}%`,
                        model: config.embedding.model,
                        provider: config.embedding.provider as string,
                    });
                    return;
                }

                if (opts.reset) {
                    log.info(
                        `Resetting vec_chunks for ${config.embedding.dimensions}-dimension model "${config.embedding.model}"...`,
                    );
                    resetVecTable(config.embedding.dimensions);
                    log.success('vec_chunks reset. All chunks marked for re-embedding.');
                }

                const statsBefore = embeddingStats();
                if (statsBefore.pending === 0) {
                    log.success('All chunks already embedded.');
                    return;
                }

                log.info(
                    `Embedding ${statsBefore.pending} chunks via ${config.embedding.provider} (${config.embedding.model})...`,
                );

                const count = await embedPending(config);
                log.success(`Embedded ${count} chunks.`);
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
