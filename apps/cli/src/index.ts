/**
 * Public library entry for Lumen.
 *
 * Usage (current package name, will publish as `lumen-kb` after the 6.4 rename):
 *     import { createLumen } from '@lumen/cli';
 *     const lumen = createLumen({ dataDir: './my-wiki' });
 *     const results = await lumen.search({ query: 'attention', limit: 10 });
 *     lumen.close();
 *
 * Design notes:
 * - Strict-pure: every method returns data or throws a typed `LumenError`.
 *   No `console.log`, no `process.exit`. The CLI wraps these with logger
 *   and exit-code handling.
 * - The underlying store uses a module-level singleton (better-sqlite3).
 *   Multiple `createLumen()` calls in the same process share state. If you
 *   need to switch data directories at runtime, call `close()` first.
 * - Lazy initialisation: the DB opens on first method call, not on factory
 *   construction. This keeps `createLumen()` cheap and lets callers
 *   configure options without triggering file I/O.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { setDataDir, isInitialized, getDataDir } from './utils/paths.js';
import { getDb, closeDb } from './store/database.js';
import {
    search as searchImpl,
    type SearchOptions,
    type LibrarySearchResult,
} from './lib/search.js';
import { getStatus, type LumenStatus } from './lib/status.js';
import { createGraphApi, type GraphApi } from './lib/graph.js';
import { addSource, type AddInput, type AddResult } from './lib/add.js';
import { ask as askImpl, type AskOptions, type AskResult } from './lib/ask.js';
import { compile as compileImpl, type CompileOptions, type CompileResult } from './lib/compile.js';
import { createWatchApi, type WatchApi } from './lib/watch.js';
import { createSourcesApi, type SourcesApi, type SourcesListOptions } from './lib/sources.js';
import { createConceptsApi, type ConceptsApi, type ConceptsListOptions } from './lib/concepts.js';
import { createChunksApi, type ChunksApi, type ChunksListOptions } from './lib/chunks.js';
import { withHook, type LumenCallHook } from './lib/hook.js';
import { getProfile } from './profile/cache.js';
import type { LumenProfile } from './profile/builder.js';
import { LumenError, LumenNotInitializedError } from './lib/errors.js';

export type CreateLumenOptions = {
    /** Absolute path to the Lumen workspace. Defaults to `$LUMEN_DIR` or `~/.lumen`. */
    dataDir?: string;
    /** Create the workspace directory and database if it doesn't exist yet. */
    autoInit?: boolean;
    /**
     * Observability hook invoked twice per public method call:
     * `phase: 'start'` before the call runs, then `phase: 'success'` or
     * `phase: 'error'` once it settles. Use the shared `call_id` to
     * correlate the two. Hook errors are swallowed; the library never
     * awaits your handler.
     *
     * Zero cost when omitted — `createLumen` skips instrumentation entirely.
     */
    onCall?: LumenCallHook;
};

export type Lumen = {
    /** Ingest a URL/path/handle. Fetches, chunks, and inserts into the store.
     *  Returns `{ status: 'skipped' }` on content-hash dedup. */
    add(input: AddInput): Promise<AddResult>;
    /** Hybrid BM25 + TF-IDF search with RRF fusion. */
    search(opts: SearchOptions): LibrarySearchResult[];
    /** Retrieval-augmented Q&A. Requires an LLM API key. */
    ask(opts: AskOptions): Promise<AskResult>;
    /** LLM compilation: sources → concepts + edges. Requires an API key. */
    compile(opts?: CompileOptions): Promise<CompileResult>;
    /** Counts across sources, chunks, concepts, edges, connectors. */
    status(): LumenStatus;
    /** Cached profile snapshot (static + dynamic + learned). */
    profile(opts?: { refresh?: boolean }): LumenProfile;
    /** Graph operations namespace. */
    graph: GraphApi;
    /** Connector management + manual pulls. */
    watch: WatchApi;
    /** Source row reads — get, list (with filters), count. */
    sources: SourcesApi;
    /** Concept reads — `get(slug)` returns a hydrated `ConceptDetail` (edges + sources). */
    concepts: ConceptsApi;
    /** Chunk reads — useful to resolve `ask()` citations into full text. */
    chunks: ChunksApi;
    /** Absolute path of the active workspace. */
    dataDir(): string;
    /** Close the underlying SQLite handle. Safe to call multiple times. */
    close(): void;
};

/**
 * Build a Lumen engine handle. See module doc for usage.
 */
export function createLumen(options: CreateLumenOptions = {}): Lumen {
    const resolvedDir = resolveDataDir(options.dataDir, options.autoInit === true);

    let dbOpened = false;
    const ensureOpen = (): void => {
        if (dbOpened) return;
        setDataDir(resolvedDir);
        if (!options.autoInit && !isInitialized()) {
            throw new LumenNotInitializedError(resolvedDir);
        }
        /** Opens (or creates) the SQLite file and runs migrations. */
        getDb();
        dbOpened = true;
    };

    const graph = createGraphApi();
    const watch = createWatchApi();
    const sources = createSourcesApi();
    const concepts = createConceptsApi();
    const chunks = createChunksApi();

    /**
     * Local helper that threads the configured `onCall` hook through every
     * public method. When `onCall` is undefined `withHook` returns the
     * original function untouched, keeping the zero-overhead contract.
     */
    const wrap = <Args extends unknown[], R>(
        name: string,
        fn: (...a: Args) => R,
    ): ((...a: Args) => R) => withHook(name, fn, options.onCall);

    return Object.freeze({
        add: wrap('add', async (input: AddInput): Promise<AddResult> => {
            ensureOpen();
            return addSource(input);
        }),

        search: wrap('search', (opts: SearchOptions): LibrarySearchResult[] => {
            ensureOpen();
            return searchImpl(opts);
        }),

        ask: wrap('ask', async (opts: AskOptions): Promise<AskResult> => {
            ensureOpen();
            return askImpl(opts);
        }),

        compile: wrap('compile', async (opts?: CompileOptions): Promise<CompileResult> => {
            ensureOpen();
            return compileImpl(opts);
        }),

        status: wrap('status', (): LumenStatus => {
            ensureOpen();
            return getStatus();
        }),

        profile: wrap('profile', (opts?: { refresh?: boolean }): LumenProfile => {
            ensureOpen();
            /** `getProfile(true)` already bypasses + rewrites the cache. */
            return getProfile(opts?.refresh === true);
        }),

        watch: Object.freeze({
            add: wrap('watch.add', (opts: Parameters<WatchApi['add']>[0]) => {
                ensureOpen();
                return watch.add(opts);
            }),
            list: wrap('watch.list', (opts?: Parameters<WatchApi['list']>[0]) => {
                ensureOpen();
                return watch.list(opts);
            }),
            get: wrap('watch.get', (id: string) => {
                ensureOpen();
                return watch.get(id);
            }),
            remove: wrap('watch.remove', (id: string) => {
                ensureOpen();
                return watch.remove(id);
            }),
            pull: wrap('watch.pull', (id: string) => {
                ensureOpen();
                return watch.pull(id);
            }),
            run: wrap('watch.run', () => {
                ensureOpen();
                return watch.run();
            }),
            runDue: wrap('watch.runDue', () => {
                ensureOpen();
                return watch.runDue();
            }),
            handlerTypes: wrap('watch.handlerTypes', () => watch.handlerTypes()),
        }),

        sources: Object.freeze({
            get: wrap('sources.get', (id: string) => {
                ensureOpen();
                return sources.get(id);
            }),
            list: wrap('sources.list', (opts?: SourcesListOptions) => {
                ensureOpen();
                return sources.list(opts);
            }),
            count: wrap('sources.count', () => {
                ensureOpen();
                return sources.count();
            }),
            countByType: wrap('sources.countByType', () => {
                ensureOpen();
                return sources.countByType();
            }),
        }),

        concepts: Object.freeze({
            get: wrap('concepts.get', (slug: string) => {
                ensureOpen();
                return concepts.get(slug);
            }),
            list: wrap('concepts.list', (opts?: ConceptsListOptions) => {
                ensureOpen();
                return concepts.list(opts);
            }),
            count: wrap('concepts.count', () => {
                ensureOpen();
                return concepts.count();
            }),
        }),

        chunks: Object.freeze({
            get: wrap('chunks.get', (id: string) => {
                ensureOpen();
                return chunks.get(id);
            }),
            list: wrap('chunks.list', (opts: ChunksListOptions) => {
                ensureOpen();
                return chunks.list(opts);
            }),
            count: wrap('chunks.count', () => {
                ensureOpen();
                return chunks.count();
            }),
        }),

        graph: Object.freeze({
            godNodes: wrap('graph.godNodes', (limit?: number) => {
                ensureOpen();
                return graph.godNodes(limit);
            }),
            pagerank: wrap('graph.pagerank', (opts?: Parameters<GraphApi['pagerank']>[0]) => {
                ensureOpen();
                return graph.pagerank(opts);
            }),
            neighbors: wrap('graph.neighbors', (slug: string, depth?: number) => {
                ensureOpen();
                return graph.neighbors(slug, depth);
            }),
            path: wrap('graph.path', (from: string, to: string, maxDepth?: number) => {
                ensureOpen();
                return graph.path(from, to, maxDepth);
            }),
            communities: wrap('graph.communities', (maxIterations?: number) => {
                ensureOpen();
                return graph.communities(maxIterations);
            }),
            components: wrap('graph.components', () => {
                ensureOpen();
                return graph.components();
            }),
            toJson: wrap('graph.toJson', () => {
                ensureOpen();
                return graph.toJson();
            }),
            toDot: wrap('graph.toDot', () => {
                ensureOpen();
                return graph.toDot();
            }),
            report: wrap('graph.report', () => {
                ensureOpen();
                return graph.report();
            }),
        }),

        /** Unhooked — `dataDir()` and `close()` are lifecycle accessors, not
         *  logical calls. Instrumenting them would inflate traces with
         *  housekeeping events that no agent wants to see. */
        dataDir(): string {
            return getDataDir();
        },

        close(): void {
            if (!dbOpened) return;
            closeDb();
            dbOpened = false;
        },
    });
}

function resolveDataDir(dataDir: string | undefined, autoInit: boolean): string {
    if (!dataDir) return getDataDir();
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
        throw new LumenError(
            'INVALID_ARGUMENT',
            'createLumen(): `dataDir` must be a non-empty string',
        );
    }
    if (autoInit && !existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
}

/** Re-exports for consumers that want direct access to the typed errors. */
export { LumenError, LumenNotInitializedError } from './lib/errors.js';
export { IngestError } from './ingest/errors.js';
export type { LumenErrorCode } from './lib/errors.js';
export type { SearchOptions, LibrarySearchResult } from './lib/search.js';
export type { LumenStatus } from './lib/status.js';
export type { GraphApi } from './lib/graph.js';
export type { AddInput, AddResult } from './lib/add.js';
export type { AskOptions, AskResult, AskSource, Citation, Verdict } from './lib/ask.js';
export type { CompileOptions, CompileResult, PerSourceOutcome } from './lib/compile.js';
export type { WatchApi, WatchAddOptions } from './lib/watch.js';
export type { SourcesApi, SourcesListOptions } from './lib/sources.js';
export type { ConceptsApi, ConceptsListOptions, ConceptDetail, EdgeRef } from './lib/concepts.js';
export type { ChunksApi, ChunksListOptions } from './lib/chunks.js';
export type { LumenCallEvent, LumenCallHook } from './lib/hook.js';
export type { LumenProfile } from './profile/builder.js';
export type {
    SourceType,
    IngestErrorCode,
    Connector,
    ConnectorType,
    Source,
    Chunk,
    ChunkType,
    Concept,
    Edge,
    RelationType,
} from './types/index.js';
export type { PullSummary } from './connectors/index.js';

/** Paths helpers — useful when consumers want to know where things live. */
export { getDbPath } from './utils/paths.js';
