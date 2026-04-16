import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { getDb } from '../store/database.js';
import { getStmt } from '../store/prepared.js';
import { LumenError } from './errors.js';

export type SearchMode = 'hybrid' | 'bm25' | 'tfidf';

export type SearchOptions = {
    query: string;
    limit?: number;
    mode?: SearchMode;
};

export type LibrarySearchResult = {
    chunk_id: string;
    source_id: string;
    source_title: string;
    heading: string | null;
    content: string;
    score: number;
    rank: number;
};

const DEFAULT_LIMIT = 10;

/**
 * Hybrid BM25 + TF-IDF retrieval fused with RRF (k=60). The CLI's
 * `lumen search` is a formatter over this function.
 *
 * Returns resolved chunks with source titles + content, not raw IDs.
 */
export function search(opts: SearchOptions): LibrarySearchResult[] {
    const query = opts.query?.trim();
    if (!query) {
        throw new LumenError('INVALID_ARGUMENT', 'search(): `query` is required and non-empty');
    }

    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const mode: SearchMode = opts.mode ?? 'hybrid';

    const fused = runRetrieval(query, limit, mode);
    if (fused.length === 0) return [];

    return resolveHits(fused.slice(0, limit));
}

type Hit = { chunk_id: string; source_id: string; score: number };

function runRetrieval(query: string, limit: number, mode: SearchMode): Hit[] {
    if (mode === 'bm25') {
        return searchBm25(query, limit).map((r) => ({
            chunk_id: r.chunk_id,
            source_id: r.source_id,
            score: r.score,
        }));
    }
    if (mode === 'tfidf') {
        return searchTfIdf(query, limit).map((r) => ({
            chunk_id: r.chunk_id,
            source_id: r.source_id,
            score: r.score,
        }));
    }

    /** Hybrid: pull 2× from each signal, fuse, keep top `limit`. */
    const bm25 = searchBm25(query, limit * 2);
    const tfidf = searchTfIdf(query, limit * 2);
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
    return fused.map((r) => ({
        chunk_id: r.chunk_id,
        source_id: r.source_id,
        score: r.rrf_score,
    }));
}

function resolveHits(hits: Hit[]): LibrarySearchResult[] {
    if (hits.length === 0) return [];
    const db = getDb();

    /** Cached prepared statements — shared across every `search()` call on
     *  this DB handle. `closeDb()` drops the cache so reopens are clean. */
    const chunkStmt = getStmt(db, 'SELECT content, heading FROM chunks WHERE id = ?');
    const sourceStmt = getStmt(db, 'SELECT title FROM sources WHERE id = ?');

    const out: LibrarySearchResult[] = [];
    for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const chunk = chunkStmt.get(h.chunk_id) as
            | { content: string; heading: string | null }
            | undefined;
        const source = sourceStmt.get(h.source_id) as { title: string } | undefined;

        out.push({
            chunk_id: h.chunk_id,
            source_id: h.source_id,
            source_title: source?.title ?? h.source_id,
            heading: chunk?.heading ?? null,
            content: chunk?.content ?? '',
            score: h.score,
            rank: i + 1,
        });
    }
    return out;
}
