import { listSources, getSource } from '../store/sources.js';
import { compileSource } from '../llm/compiler.js';
import { generateReport } from '../graph/report.js';
import { loadConfig } from '../utils/config.js';
import { invalidateProfile, withBatchedInvalidation } from '../profile/invalidate.js';
import type { CompilationResult } from '../types/index.js';
import { LumenError } from './errors.js';

export type CompileOptions = {
    /** Compile all sources even if already compiled. Default: only uncompiled. */
    all?: boolean;
    /** Restrict compilation to a specific set of source IDs. */
    sourceIds?: string[];
    /** Also write GRAPH_REPORT.md after compilation. Default false. */
    writeReport?: boolean;
    /** Max sources to compile in parallel. Default 3. */
    concurrency?: number;
};

export type PerSourceOutcome =
    | { source_id: string; status: 'compiled'; result: CompilationResult }
    | { source_id: string; status: 'failed'; error: string };

export type CompileResult = {
    sources_total: number;
    sources_compiled: number;
    sources_failed: number;
    concepts_created: number;
    concepts_updated: number;
    edges_created: number;
    tokens_used: number;
    /** Absolute path of the generated report if `writeReport` was true. */
    report_path: string | null;
    outcomes: PerSourceOutcome[];
};

/**
 * Iterate sources (all / uncompiled / explicit set) and run LLM compilation
 * on each. Individual source failures are captured in the result — only a
 * top-level error (missing API key, invalid args) throws.
 */
export async function compile(opts: CompileOptions = {}): Promise<CompileResult> {
    const config = loadConfig();
    if (!config.llm.api_key) {
        throw new LumenError(
            'MISSING_API_KEY',
            'No LLM API key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.',
            {
                hint: 'Run `lumen config --api-key <key>` or export an env var before calling compile().',
            },
        );
    }

    const sources = selectSources(opts);

    const outcomes: PerSourceOutcome[] = [];
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalEdges = 0;
    let totalTokens = 0;

    /** Batch the whole compile loop. Each source's LLM pass can upsert many
     *  concepts + edges + call markCompiled(), all of which individually
     *  invalidate the profile. Without batching: 2500+ SQL UPDATEs for
     *  100 sources. With batching: 1. */
    const concurrency = Math.max(1, opts.concurrency ?? 3);

    await withBatchedInvalidation(async () => {
        /** Pre-partition sources by stride — each worker owns fixed indices,
         *  no shared mutable queue needed. */
        const workers = Array.from({ length: concurrency }, async (_, w) => {
            for (let i = w; i < sources.length; i += concurrency) {
                const src = sources[i];
                try {
                    const result = await compileSource(src.id, src.title, config);
                    outcomes.push({ source_id: src.id, status: 'compiled', result });
                    totalCreated += result.concepts_created.length;
                    totalUpdated += result.concepts_updated.length;
                    totalEdges += result.edges_created;
                    totalTokens += result.tokens_used;
                } catch (err) {
                    outcomes.push({
                        source_id: src.id,
                        status: 'failed',
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        });

        await Promise.all(workers);

        const compiledCount = outcomes.filter((o) => o.status === 'compiled').length;
        if (compiledCount > 0) invalidateProfile();
    });

    const compiledCount = outcomes.filter((o) => o.status === 'compiled').length;
    const failedCount = outcomes.length - compiledCount;

    let reportPath: string | null = null;
    if (opts.writeReport) {
        /** `generateReport()` returns the written path. Surface any throw. */
        reportPath = generateReport();
    }

    return {
        sources_total: sources.length,
        sources_compiled: compiledCount,
        sources_failed: failedCount,
        concepts_created: totalCreated,
        concepts_updated: totalUpdated,
        edges_created: totalEdges,
        tokens_used: totalTokens,
        report_path: reportPath,
        outcomes,
    };
}

function selectSources(opts: CompileOptions): Array<{ id: string; title: string }> {
    if (opts.sourceIds && opts.sourceIds.length > 0) {
        const found: Array<{ id: string; title: string }> = [];
        for (const id of opts.sourceIds) {
            const src = getSource(id);
            if (!src) {
                throw new LumenError('NOT_FOUND', `Source not found: ${id}`);
            }
            found.push({ id: src.id, title: src.title });
        }
        return found;
    }

    return opts.all
        ? listSources().map((s) => ({ id: s.id, title: s.title }))
        : listSources({ compiled: false }).map((s) => ({ id: s.id, title: s.title }));
}
