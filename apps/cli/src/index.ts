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
import { getProfile } from './profile/cache.js';
import type { LumenProfile } from './profile/builder.js';
import { LumenError, LumenNotInitializedError } from './lib/errors.js';

export type CreateLumenOptions = {
    /** Absolute path to the Lumen workspace. Defaults to `$LUMEN_DIR` or `~/.lumen`. */
    dataDir?: string;
    /** Create the workspace directory and database if it doesn't exist yet. */
    autoInit?: boolean;
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

    return Object.freeze({
        async add(input: AddInput): Promise<AddResult> {
            ensureOpen();
            return addSource(input);
        },

        search(opts: SearchOptions): LibrarySearchResult[] {
            ensureOpen();
            return searchImpl(opts);
        },

        async ask(opts: AskOptions): Promise<AskResult> {
            ensureOpen();
            return askImpl(opts);
        },

        async compile(opts?: CompileOptions): Promise<CompileResult> {
            ensureOpen();
            return compileImpl(opts);
        },

        status(): LumenStatus {
            ensureOpen();
            return getStatus();
        },

        profile(opts?: { refresh?: boolean }): LumenProfile {
            ensureOpen();
            /** `getProfile(true)` already bypasses + rewrites the cache. */
            return getProfile(opts?.refresh === true);
        },

        watch: Object.freeze({
            add(opts: Parameters<WatchApi['add']>[0]) {
                ensureOpen();
                return watch.add(opts);
            },
            list(opts?: Parameters<WatchApi['list']>[0]) {
                ensureOpen();
                return watch.list(opts);
            },
            get(id: string) {
                ensureOpen();
                return watch.get(id);
            },
            remove(id: string) {
                ensureOpen();
                return watch.remove(id);
            },
            pull(id: string) {
                ensureOpen();
                return watch.pull(id);
            },
            run() {
                ensureOpen();
                return watch.run();
            },
            runDue() {
                ensureOpen();
                return watch.runDue();
            },
            handlerTypes() {
                return watch.handlerTypes();
            },
        }),

        graph: Object.freeze({
            godNodes(limit?: number) {
                ensureOpen();
                return graph.godNodes(limit);
            },
            pagerank(opts?: Parameters<GraphApi['pagerank']>[0]) {
                ensureOpen();
                return graph.pagerank(opts);
            },
            neighbors(slug: string, depth?: number) {
                ensureOpen();
                return graph.neighbors(slug, depth);
            },
            path(from: string, to: string, maxDepth?: number) {
                ensureOpen();
                return graph.path(from, to, maxDepth);
            },
            communities(maxIterations?: number) {
                ensureOpen();
                return graph.communities(maxIterations);
            },
            components() {
                ensureOpen();
                return graph.components();
            },
            toJson() {
                ensureOpen();
                return graph.toJson();
            },
            toDot() {
                ensureOpen();
                return graph.toDot();
            },
            report() {
                ensureOpen();
                return graph.report();
            },
        }),

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
export type { AskOptions, AskResult, AskSource } from './lib/ask.js';
export type { CompileOptions, CompileResult, PerSourceOutcome } from './lib/compile.js';
export type { WatchApi, WatchAddOptions } from './lib/watch.js';
export type { LumenProfile } from './profile/builder.js';
export type { SourceType, IngestErrorCode, Connector, ConnectorType } from './types/index.js';
export type { PullSummary } from './connectors/index.js';

/** Paths helpers — useful when consumers want to know where things live. */
export { getDbPath } from './utils/paths.js';
