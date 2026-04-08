import { getDb } from '../store/database.js';

/**
 * Pure TypeScript TF-IDF engine with inverted index.
 * Builds vocabulary from all chunks in the database,
 * computes IDF weights, and scores queries via cosine similarity.
 *
 * Reference: Salton & Buckley, "Term-weighting approaches in
 * automatic text retrieval", 1988.
 */

type TermFreqs = Map<string, number>;

type ScoredChunk = {
    chunk_id: string;
    source_id: string;
    score: number;
};

/** Inverted index: term → list of { chunk rowid, tf } */
type PostingList = { rowid: number; chunkId: string; sourceId: string; tf: number }[];

let cachedIndex: TfIdfIndex | null = null;
let cachedDocCount = 0;

type TfIdfIndex = {
    postings: Map<string, PostingList>;
    idf: Map<string, number>;
    docNorms: Map<number, number>;
    docCount: number;
};

/** Build or return the cached TF-IDF index from all chunks. */
export function getIndex(): TfIdfIndex {
    const currentCount = (getDb().prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;

    /** Rebuild if chunk count changed. */
    if (cachedIndex && cachedDocCount === currentCount) return cachedIndex;

    cachedIndex = buildIndex();
    cachedDocCount = currentCount;
    return cachedIndex;
}

/** Force a full index rebuild. */
export function rebuildIndex(): TfIdfIndex {
    cachedIndex = null;
    cachedDocCount = 0;
    return getIndex();
}

function buildIndex(): TfIdfIndex {
    const rows = getDb().prepare('SELECT rowid, id, source_id, content FROM chunks').all() as {
        rowid: number;
        id: string;
        source_id: string;
        content: string;
    }[];

    const postings = new Map<string, PostingList>();
    const docNorms = new Map<number, number>();
    const docCount = rows.length;

    /** Build term frequency per document and populate postings lists. */
    for (const row of rows) {
        const terms = tokenize(row.content);
        const tf = termFrequency(terms);
        let normSquared = 0;

        for (const [term, freq] of tf) {
            const logTf = 1 + Math.log(freq);
            normSquared += logTf * logTf;

            let list = postings.get(term);
            if (!list) {
                list = [];
                postings.set(term, list);
            }
            list.push({ rowid: row.rowid, chunkId: row.id, sourceId: row.source_id, tf: logTf });
        }

        docNorms.set(row.rowid, Math.sqrt(normSquared));
    }

    /** Compute IDF for each term. */
    const idf = new Map<string, number>();
    for (const [term, list] of postings) {
        idf.set(term, Math.log(docCount / list.length));
    }

    return { postings, idf, docNorms, docCount };
}

/**
 * Search chunks by TF-IDF cosine similarity.
 * Returns scored chunks sorted by relevance, normalized to [0, 1].
 */
export function searchTfIdf(query: string, limit = 20): ScoredChunk[] {
    const index = getIndex();
    if (index.docCount === 0) return [];

    const queryTerms = tokenize(query);
    const queryTf = termFrequency(queryTerms);

    /** Compute query vector norm. */
    let queryNormSquared = 0;
    const queryWeights = new Map<string, number>();
    for (const [term, freq] of queryTf) {
        const idfVal = index.idf.get(term) ?? 0;
        const weight = (1 + Math.log(freq)) * idfVal;
        queryWeights.set(term, weight);
        queryNormSquared += weight * weight;
    }
    const queryNorm = Math.sqrt(queryNormSquared);
    if (queryNorm === 0) return [];

    /** Accumulate dot products across matching postings. */
    const scores = new Map<number, { chunkId: string; sourceId: string; dot: number }>();

    for (const [term, queryWeight] of queryWeights) {
        const postingList = index.postings.get(term);
        if (!postingList) continue;

        const idfVal = index.idf.get(term)!;
        for (const posting of postingList) {
            const docWeight = posting.tf * idfVal;
            const existing = scores.get(posting.rowid);
            if (existing) {
                existing.dot += queryWeight * docWeight;
            } else {
                scores.set(posting.rowid, {
                    chunkId: posting.chunkId,
                    sourceId: posting.sourceId,
                    dot: queryWeight * docWeight,
                });
            }
        }
    }

    /** Normalize by document and query norms → cosine similarity. */
    const results: ScoredChunk[] = [];
    for (const [rowid, entry] of scores) {
        const docNorm = index.docNorms.get(rowid) ?? 1;
        results.push({
            chunk_id: entry.chunkId,
            source_id: entry.sourceId,
            score: entry.dot / (docNorm * queryNorm),
        });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
}

/** Tokenize text into lowercase terms, splitting on non-alphanumeric and camelCase. */
export function tokenize(text: string): string[] {
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2);
}

function termFrequency(terms: string[]): TermFreqs {
    const tf: TermFreqs = new Map();
    for (const term of terms) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    return tf;
}
