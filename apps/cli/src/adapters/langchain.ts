/**
 * LangChain retriever adapter for Lumen.
 *
 * Returns a retriever object with an `invoke(query)` method that produces
 * `Document[]` — the same shape LangChain uses throughout its RAG chains.
 * Zero-dep on `@langchain/core`: the adapter defines `LumenDocument`
 * structurally so consumers don't pay for the LangChain package unless
 * they want to plug the retriever into a full chain.
 *
 *     import { createLumen } from '@lumen/cli';
 *     import { lumenRetriever } from '@lumen/cli/langchain';
 *
 *     const lumen = createLumen({ dataDir: '~/.lumen' });
 *     const retriever = lumenRetriever(lumen, { limit: 10 });
 *     const docs = await retriever.invoke('attention mechanisms');
 *     // docs[0].pageContent → chunk text
 *     // docs[0].metadata   → { source_id, source_title, heading, score, rank }
 *
 * For full chain integration:
 *     import { RunnablePassthrough } from '@langchain/core/runnables';
 *     const chain = RunnablePassthrough.assign({
 *         context: (input) => retriever.invoke(input.question),
 *     }).pipe(prompt).pipe(model).pipe(parser);
 */

import type { Lumen } from '../index.js';
import { LumenError } from '../lib/errors.js';

/**
 * Structurally matches `DocumentInterface` from `@langchain/core/documents`
 * so consumers can pass these objects directly to LangChain utilities
 * without type errors.
 */
export type LumenDocument = {
    pageContent: string;
    metadata: {
        chunk_id: string;
        source_id: string;
        source_title: string;
        heading: string | null;
        score: number;
        rank: number;
    };
    id?: string;
};

export type LumenRetrieverOptions = {
    /** Max chunks to retrieve per query. Default 10. */
    limit?: number;
    /** Retrieval mode. Default 'hybrid'. */
    mode?: 'hybrid' | 'bm25' | 'tfidf';
};

export type LumenRetriever = {
    /** Primary entry — mirrors `Runnable.invoke()` from LangChain. */
    invoke(query: string): Promise<LumenDocument[]>;
    /** Batch convenience — run multiple queries. */
    batch(queries: string[]): Promise<LumenDocument[][]>;
    /** Access the options this retriever was created with. */
    options: Required<LumenRetrieverOptions>;
};

/**
 * Build a LangChain-compatible retriever backed by Lumen's hybrid search.
 *
 * The returned object exposes `invoke(query)` returning `LumenDocument[]`
 * (structurally compatible with `@langchain/core/documents`). Use it
 * standalone or as a step in a LangChain Runnable pipeline.
 *
 * Note: this project forbids `class` declarations (CLAUDE.md hard rule).
 * LangChain's `BaseRetriever` expects class inheritance for full Runnable
 * support (pipe, stream, withConfig). This adapter provides the 90% path
 * (invoke + batch) as a plain object. For the remaining 10% (deep chain
 * composition), extend `BaseRetriever` yourself and delegate to
 * `retriever.invoke()` in `_getRelevantDocuments`.
 */
export function lumenRetriever(lumen: Lumen, opts: LumenRetrieverOptions = {}): LumenRetriever {
    const limit = Math.max(1, opts.limit ?? 10);
    const mode = opts.mode ?? 'hybrid';

    return {
        async invoke(query: string): Promise<LumenDocument[]> {
            if (typeof query !== 'string' || !query.trim()) {
                throw new LumenError(
                    'INVALID_ARGUMENT',
                    'lumenRetriever.invoke(): query must be a non-empty string',
                );
            }

            const results = lumen.search({ query: query.trim(), limit, mode });

            return results.map(
                (r): LumenDocument => ({
                    pageContent: r.content,
                    metadata: {
                        chunk_id: r.chunk_id,
                        source_id: r.source_id,
                        source_title: r.source_title,
                        heading: r.heading,
                        score: r.score,
                        rank: r.rank,
                    },
                    id: r.chunk_id,
                }),
            );
        },

        async batch(queries: string[]): Promise<LumenDocument[][]> {
            /** Sequential — preserves store-singleton semantics and keeps
             *  retrieval deterministic. Agents needing parallelism can
             *  `Promise.all` over `invoke()` themselves. */
            const out: LumenDocument[][] = [];
            for (const q of queries) {
                out.push(await this.invoke(q));
            }
            return out;
        },

        options: { limit, mode },
    };
}
