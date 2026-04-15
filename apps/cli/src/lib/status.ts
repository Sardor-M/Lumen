import { statSync } from 'node:fs';
import { countSources, countSourcesByType } from '../store/sources.js';
import { countChunks, totalTokens } from '../store/chunks.js';
import { countConcepts } from '../store/concepts.js';
import { countEdges } from '../store/edges.js';
import { countConnectors } from '../store/connectors.js';
import { getDataDir, getDbPath } from '../utils/paths.js';

export type LumenStatus = {
    data_dir: string;
    db_bytes: number;
    sources: number;
    chunks: number;
    total_tokens: number;
    concepts: number;
    edges: number;
    connectors: number;
    sources_by_type: Record<string, number>;
    graph_density: number | null;
};

/**
 * Single-shot summary of workspace state. Assumes the DB is open —
 * `createLumen()` guarantees that before delegating here.
 */
export function getStatus(): LumenStatus {
    const sources = countSources();
    const chunks = countChunks();
    const tokens = totalTokens();
    const concepts = countConcepts();
    const edges = countEdges();
    const connectors = countConnectors();
    const byType = countSourcesByType();

    let dbBytes = 0;
    try {
        dbBytes = statSync(getDbPath()).size;
    } catch {
        /** DB file may be missing on a freshly-initialised dir — report 0. */
    }

    const density =
        concepts > 1 ? (2 * edges) / (concepts * (concepts - 1)) : concepts === 0 ? null : 0;

    return {
        data_dir: getDataDir(),
        db_bytes: dbBytes,
        sources,
        chunks,
        total_tokens: tokens,
        concepts,
        edges,
        connectors,
        sources_by_type: byType,
        graph_density: density,
    };
}
