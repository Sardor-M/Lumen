import { getDb } from '../store/database.js';
import type { SearchResult, ChunkType } from '../types/index.js';

/**
 * BM25 search via SQLite FTS5.
 * Returns ranked results with normalized scores in [0, 1].
 */
export function searchBm25(query: string, limit = 20): SearchResult[] {
    /** Quote each term so FTS5 doesn't misinterpret special chars. */
    const escaped = query
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' ');

    if (!escaped) return [];

    const rows = getDb()
        .prepare(
            `SELECT
         c.id          AS chunk_id,
         c.source_id,
         s.title       AS source_title,
         c.content,
         c.chunk_type,
         c.heading,
         rank
       FROM chunks_fts f
       JOIN chunks c ON c.rowid = f.rowid
       JOIN sources s ON s.id = c.source_id
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
        )
        .all(escaped, limit) as RawFtsRow[];

    if (rows.length === 0) return [];

    /** FTS5 rank values are negative (more negative = more relevant). Normalize to [0, 1]. */
    const minRank = rows[rows.length - 1].rank;
    const maxRank = rows[0].rank;
    const range = maxRank - minRank || 1;

    return rows.map((row) => ({
        chunk_id: row.chunk_id,
        source_id: row.source_id,
        source_title: row.source_title,
        content: row.content,
        snippet: makeSnippet(row.content, query),
        score: (row.rank - minRank) / range,
        chunk_type: row.chunk_type as ChunkType,
        heading: row.heading,
    }));
}

type RawFtsRow = {
    chunk_id: string;
    source_id: string;
    source_title: string;
    content: string;
    chunk_type: string;
    heading: string | null;
    rank: number;
};

/**
 * Create a short snippet around the first query term match.
 * Returns up to 200 chars centered on the match.
 */
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
