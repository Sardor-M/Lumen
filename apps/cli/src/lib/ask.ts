import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { getSource } from '../store/sources.js';
import { chat } from '../llm/client.js';
import { QA_SYSTEM, qaUserPrompt } from '../llm/prompts/qa.js';
import { loadConfig } from '../utils/config.js';
import { logQuery } from '../store/query-log.js';
import { LumenError } from './errors.js';

export type AskOptions = {
    question: string;
    /** Max chunks to consider from fused retrieval before budget selection. */
    limit?: number;
    /** Token budget for retrieved context. Falls back to `config.search.token_budget`. */
    budget?: number;
    /** Max output tokens from the LLM. */
    maxTokens?: number;
};

export type AskSource = {
    source_id: string;
    source_title: string;
    content: string;
    score: number;
};

export type AskResult = {
    answer: string;
    sources: AskSource[];
};

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Retrieval-augmented Q&A: hybrid search → budget selection → LLM synthesis.
 *
 * Requires an API key in config or env (`ANTHROPIC_API_KEY` /
 * `OPENROUTER_API_KEY`). Throws `LumenError('INVALID_ARGUMENT')` when the
 * question is empty and `LumenError('UNKNOWN')` when no API key is set.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
    const question = opts.question?.trim();
    if (!question) {
        throw new LumenError('INVALID_ARGUMENT', 'ask(): `question` is required and non-empty');
    }

    const config = loadConfig();
    if (!config.llm.api_key) {
        throw new LumenError(
            'UNKNOWN',
            'No LLM API key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.',
            {
                hint: 'Run `lumen config --api-key <key>` or export an env var before calling ask().',
            },
        );
    }

    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const budget = opts.budget ?? config.search.token_budget;
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

    const started = Date.now();

    const bm25 = searchBm25(question, limit * 2);
    const tfidf = searchTfIdf(question, limit * 2);

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

    const selected = selectByBudget(
        fused.slice(0, limit).map((r) => ({
            chunk_id: r.chunk_id,
            source_id: r.source_id,
            score: r.rrf_score,
        })),
        budget,
    );

    if (selected.length === 0) {
        /** Empty answer is preferable to throwing — the caller decides how to
         *  render "no results" in their UX. */
        return { answer: '', sources: [] };
    }

    const sources: AskSource[] = selected.map((c) => ({
        source_id: c.source_id,
        source_title: getSource(c.source_id)?.title ?? c.source_id,
        content: c.content,
        score: c.score,
    }));

    const answer = await chat(
        config,
        [
            {
                role: 'user',
                content: qaUserPrompt(
                    question,
                    sources.map((s) => ({
                        source_title: s.source_title,
                        heading: null,
                        content: s.content,
                        score: s.score,
                    })),
                ),
            },
        ],
        { system: QA_SYSTEM, maxTokens },
    );

    logQuery({
        tool_name: 'ask',
        query_text: question,
        result_count: sources.length,
        latency_ms: Date.now() - started,
        session_id: null,
    });

    return { answer, sources };
}
