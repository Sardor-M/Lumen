import type { Command } from 'commander';
import { getDb } from '../store/database.js';
import { countSources, countSourcesByType } from '../store/sources.js';
import { countChunks, totalTokens } from '../store/chunks.js';
import { countConcepts } from '../store/concepts.js';
import { countEdges } from '../store/edges.js';
import { getDataDir, getDbPath } from '../utils/paths.js';
import { isInitialized } from '../utils/paths.js';
import * as log from '../utils/logger.js';
import { statSync } from 'node:fs';

export function registerStatus(program: Command): void {
    program
        .command('status')
        .description('Show wiki statistics — sources, chunks, concepts, graph density (local, no LLM)')
        .action(() => {
            try {
                if (!isInitialized()) {
                    log.warn('Lumen is not initialized. Run `lumen init` first.');
                    return;
                }

                getDb();

                const sources = countSources();
                const chunks = countChunks();
                const tokens = totalTokens();
                const concepts = countConcepts();
                const edges = countEdges();
                const byType = countSourcesByType();

                const dbSize = formatBytes(statSync(getDbPath()).size);

                log.heading('Lumen Wiki Status');
                log.table({
                    'Data directory': getDataDir(),
                    'Database size': dbSize,
                    Sources: sources,
                    Chunks: chunks,
                    'Total tokens': tokens,
                    Concepts: concepts,
                    Edges: edges,
                });

                if (Object.keys(byType).length > 0) {
                    log.heading('Sources by Type');
                    log.table(byType);
                }

                if (concepts > 0 && edges > 0) {
                    const density = ((2 * edges) / (concepts * (concepts - 1)) || 0).toFixed(4);
                    log.heading('Graph');
                    log.table({
                        'Graph density': density,
                        'Avg edges/concept': (edges / concepts).toFixed(1),
                    });
                }
            } catch (err) {
                log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
