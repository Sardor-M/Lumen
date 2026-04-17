import { getDb } from '../store/database.js';
import { isVecAvailable } from '../store/database.js';
import type { LumenConfig, SearchResult, ChunkType } from '../types/index.js';
import { embedBatch, serializeVector } from '../embed/client.js';

type VecRow = {
    rowid: number;
    distance: number;
};

type ChunkJoinRow = {
    id: string;
    source_id: string;
    source_title: string;
    content: string;
    chunk_type: string;
    heading: string | null;
};

/**
 * Semantic similarity search via sqlite-vec ANN.
 * Embeds the query then finds the nearest chunk vectors.
 * Returns an empty array when embedding.provider is 'none' or sqlite-vec is unavailable.
 */
export async function searchVector(
    query: string,
    config: LumenConfig,
    limit = 20,
): Promise<SearchResult[]> {
    if (config.embedding.provider === 'none') return [];
    if (!isVecAvailable()) return [];

    const db = getDb();

    /** Check that vec_chunks exists and has rows before querying. */
    const vecCount = (db.prepare(`SELECT COUNT(*) AS n FROM vec_chunks`).get() as { n: number }).n;
    if (vecCount === 0) return [];

    /** Embed the query using the same model as the stored vectors. */
    const [queryVec] = await embedBatch([query], config.embedding);
    const queryBytes = serializeVector(queryVec);

    /** ANN search — vec0 KNN via MATCH + ORDER BY distance. */
    const vecRows = db
        .prepare(
            `SELECT rowid, distance
             FROM vec_chunks
             WHERE embedding MATCH ?
               AND k = ?
             ORDER BY distance`,
        )
        .all(queryBytes, limit * 2) as VecRow[];

    if (vecRows.length === 0) return [];

    /** Resolve chunk metadata for each result via rowid join. */
    const getChunk = db.prepare<[number], ChunkJoinRow>(
        `SELECT c.id, c.source_id, s.title AS source_title, c.content, c.chunk_type, c.heading
         FROM chunks c
         JOIN sources s ON s.id = c.source_id
         WHERE c.rowid = ?`,
    );

    /**
     * Normalise cosine distance (0 = identical, 2 = opposite) to score in [0, 1].
     * score = 1 - (distance / 2)
     */
    const results: SearchResult[] = [];

    for (const row of vecRows.slice(0, limit)) {
        const chunk = getChunk.get(row.rowid);
        if (!chunk) continue;

        results.push({
            chunk_id: chunk.id,
            source_id: chunk.source_id,
            source_title: chunk.source_title,
            content: chunk.content,
            snippet: makeSnippet(chunk.content, query),
            score: Math.max(0, 1 - row.distance / 2),
            chunk_type: chunk.chunk_type as ChunkType,
            heading: chunk.heading,
        });
    }

    return results;
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
    if (end < content.length) snippet += '...';

    return snippet;
}
