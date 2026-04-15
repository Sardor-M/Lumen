import { getChunk as storeGetChunk, getChunksBySource, countChunks } from '../store/chunks.js';
import type { Chunk } from '../types/index.js';
import { LumenError } from './errors.js';

export type ChunksListOptions = {
    sourceId: string;
    limit?: number;
};

export type ChunksApi = {
    /** Fetch a chunk by its store-assigned id. Useful after an `ask()` citation. */
    get(id: string): Chunk | null;
    /** Stream chunks for a given source, ordered by position. */
    list(opts: ChunksListOptions): Chunk[];
    count(): number;
};

/**
 * Chunks are the unit of retrieval — citations point at them, search ranks
 * them, compile reads them. Agents use this API to drill into the text
 * behind a citation, browse a source section-by-section, or build a
 * "show full chunk" affordance in their UI.
 */
export function createChunksApi(): ChunksApi {
    return {
        get(id: string): Chunk | null {
            requireString(id, 'chunks.get', 'id');
            return storeGetChunk(id);
        },

        list(opts: ChunksListOptions): Chunk[] {
            requireString(opts?.sourceId, 'chunks.list', 'sourceId');
            const rows = getChunksBySource(opts.sourceId);
            if (opts.limit === undefined) return rows;
            const n = coerceLimit(opts.limit, 'chunks.list', 'limit');
            return rows.slice(0, n);
        },

        count(): number {
            return countChunks();
        },
    };
}

function requireString(v: unknown, fn: string, field: string): void {
    if (typeof v !== 'string' || v.length === 0) {
        throw new LumenError('INVALID_ARGUMENT', `${fn}: \`${field}\` must be a non-empty string`);
    }
}

function coerceLimit(raw: unknown, fn: string, field: string): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        throw new LumenError('INVALID_ARGUMENT', `${fn}: \`${field}\` must be a positive integer`);
    }
    return raw;
}
