import { searchBm25 } from '../search/bm25.js';
import { searchTfIdf } from '../search/tfidf.js';
import { fuseRrf } from '../search/fusion.js';
import { selectByBudget } from '../search/budget.js';
import { getSource } from '../store/sources.js';
import { chatJson } from '../llm/client.js';
import { QA_CITABLE_SYSTEM, qaCitableUserPrompt } from '../llm/prompts/qa.js';
import { loadConfig } from '../utils/config.js';
import { logQuery } from '../store/query-log.js';
import { invalidateProfile } from '../profile/invalidate.js';
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

/**
 * How confident the LLM is that the answer is grounded in the chunks:
 * - `answered`     — every load-bearing claim is supported by a citation.
 * - `partial`      — main thesis supported, some details inferred.
 * - `uncertain`    — chunks are tangentially related; treat the answer as a guess.
 * - `no_evidence`  — no usable retrieval; agents should ask the user to refine.
 */
export type Verdict = 'answered' | 'partial' | 'uncertain' | 'no_evidence';

export type Citation = {
    /** Marker that appears as `[N]` inside `answer`. Stable for the lifetime of one ask() call. */
    marker: string;
    chunk_id: string;
    source_id: string;
    source_title: string;
    /** Verbatim substring of the cited chunk that supports the surrounding claim. */
    quote: string;
};

export type AskResult = {
    /** Synthesized answer with `[1]`, `[2]` markers tied to `citations`. */
    answer: string;
    /** Whether retrieval found any context to send to the LLM. False short-circuits the LLM call entirely. */
    found: boolean;
    /** LLM's self-reported confidence in evidence grounding. See `Verdict` for semantics. */
    verdict: Verdict;
    /** Marker → chunk mapping. May be empty even when `answer` is non-empty (e.g. `verdict: 'no_evidence'`). */
    citations: Citation[];
    /** Raw retrieved chunks. Useful for debug, ranking transparency, or building a "show your work" UI. */
    sources: AskSource[];
};

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_TOKENS = 2048;
const VALID_VERDICTS: ReadonlySet<Verdict> = new Set([
    'answered',
    'partial',
    'uncertain',
    'no_evidence',
]);

type RawCitation = {
    marker?: unknown;
    chunk_id?: unknown;
    quote?: unknown;
};

type RawCitableResponse = {
    verdict?: unknown;
    answer?: unknown;
    citations?: unknown;
};

/**
 * Retrieval-augmented Q&A returning a structured, citable answer.
 *
 * Pipeline:
 * 1. Hybrid BM25 + TF-IDF retrieval, fused via RRF.
 * 2. Budget selection — drops low-scoring chunks until the context fits.
 * 3. If retrieval is empty, return `{ verdict: 'no_evidence', found: false }`
 *    WITHOUT calling the LLM. Saves cost and surfaces empty-corpus state cleanly.
 * 4. Send chunks to the LLM with chunk aliases (C1, C2…). The LLM returns
 *    JSON with `verdict`, `answer` (with `[N]` markers), and `citations`.
 * 5. Validate citations against the alias set — drop hallucinated chunk_ids
 *    silently, downgrade `verdict` to `uncertain` if all citations are dropped.
 *
 * Throws:
 * - `LumenError('INVALID_ARGUMENT')` on empty question.
 * - `LumenError('MISSING_API_KEY')` when no API key is configured.
 * - `LumenError('LLM_ERROR')` when the provider fails (network, 5xx, etc.) —
 *   the original error is attached as `cause` so callers can inspect it.
 * - `LumenError('LLM_PARSE_ERROR')` when the model returns text we can't
 *   parse as the expected JSON shape — usually fixable by retrying.
 *
 * Agents should treat `LLM_ERROR` and `LLM_PARSE_ERROR` as retryable and
 * everything else as non-retryable.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
    const question = opts.question?.trim();
    if (!question) {
        throw new LumenError('INVALID_ARGUMENT', 'ask(): `question` is required and non-empty');
    }

    const config = loadConfig();
    if (!config.llm.api_key) {
        throw new LumenError(
            'MISSING_API_KEY',
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

    const fused = runRetrieval(question, limit);
    const selected = selectByBudget(
        fused.slice(0, limit).map((r) => ({
            chunk_id: r.chunk_id,
            source_id: r.source_id,
            score: r.rrf_score,
        })),
        budget,
    );

    if (selected.length === 0) {
        /** No context retrieved → no point burning an LLM call. Caller can
         *  branch on `found: false` to show a "no results" UI or prompt
         *  the user to ingest sources. */
        recordAndInvalidate(question, 0, started);
        return {
            answer: '',
            found: false,
            verdict: 'no_evidence',
            citations: [],
            sources: [],
        };
    }

    /** Resolve titles + assign stable aliases (C1..Cn) before sending to the
     *  LLM. The alias map insulates the LLM from real chunk IDs and makes
     *  hallucinated citations easy to detect on parse. */
    const sources: AskSource[] = selected.map((c) => ({
        source_id: c.source_id,
        source_title: getSource(c.source_id)?.title ?? c.source_id,
        content: c.content,
        score: c.score,
    }));

    const aliasMap = new Map<
        string,
        { chunk_id: string; source_id: string; source_title: string; content: string }
    >();
    const promptChunks: Array<{
        alias: string;
        source_title: string;
        heading: string | null;
        content: string;
    }> = [];
    selected.forEach((c, i) => {
        const alias = `C${i + 1}`;
        const src = sources[i];
        aliasMap.set(alias, {
            chunk_id: c.chunk_id,
            source_id: c.source_id,
            source_title: src.source_title,
            content: c.content,
        });
        promptChunks.push({
            alias,
            source_title: src.source_title,
            heading: null,
            content: c.content,
        });
    });

    /** Wrap provider + parse failures in typed errors so agents can branch on
     *  code without string-matching. The raw error chains through `cause`. */
    let raw: RawCitableResponse;
    try {
        raw = await chatJson<RawCitableResponse>(
            config,
            [{ role: 'user', content: qaCitableUserPrompt(question, promptChunks) }],
            { system: QA_CITABLE_SYSTEM, maxTokens },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isParseFailure = /not valid JSON/i.test(message);
        throw new LumenError(
            isParseFailure ? 'LLM_PARSE_ERROR' : 'LLM_ERROR',
            isParseFailure
                ? 'LLM returned a response that could not be parsed as structured JSON.'
                : `LLM call failed: ${message}`,
            {
                cause: err,
                hint: isParseFailure
                    ? 'Retry the call — transient formatting errors usually clear on a second attempt.'
                    : 'Check network, API key validity, and the provider status page.',
            },
        );
    }

    const parsed = validateResponse(raw, aliasMap);

    recordAndInvalidate(question, sources.length, started);

    return {
        answer: parsed.answer,
        found: true,
        verdict: parsed.verdict,
        citations: parsed.citations,
        sources,
    };
}

function runRetrieval(
    query: string,
    limit: number,
): Array<{ chunk_id: string; source_id: string; rrf_score: number }> {
    const bm25 = searchBm25(query, limit * 2);
    const tfidf = searchTfIdf(query, limit * 2);
    return fuseRrf(
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
}

/**
 * Map the LLM's alias-based citations back to real chunk IDs and drop any
 * citation referencing an alias the model invented. If the model used
 * markers in `answer` that no longer have a matching citation after the
 * drop, downgrade verdict to `'uncertain'` so callers don't over-trust it.
 */
function validateResponse(
    raw: RawCitableResponse,
    aliasMap: Map<
        string,
        { chunk_id: string; source_id: string; source_title: string; content: string }
    >,
): { answer: string; verdict: Verdict; citations: Citation[] } {
    const answer = typeof raw.answer === 'string' ? raw.answer : '';
    const verdictRaw = typeof raw.verdict === 'string' ? raw.verdict : '';
    const initialVerdict: Verdict = VALID_VERDICTS.has(verdictRaw as Verdict)
        ? (verdictRaw as Verdict)
        : 'uncertain';

    const rawCitations = Array.isArray(raw.citations) ? (raw.citations as RawCitation[]) : [];
    const citations: Citation[] = [];

    for (const c of rawCitations) {
        const marker = typeof c.marker === 'string' ? c.marker.trim() : '';
        const alias = typeof c.chunk_id === 'string' ? c.chunk_id.trim() : '';
        const quote = typeof c.quote === 'string' ? c.quote.trim() : '';
        if (!marker || !alias) continue;

        const resolved = aliasMap.get(alias);
        if (!resolved) {
            /** Hallucinated alias — drop silently; verdict adjustment below
             *  catches the case where the answer body still references it. */
            continue;
        }

        citations.push({
            marker,
            chunk_id: resolved.chunk_id,
            source_id: resolved.source_id,
            source_title: resolved.source_title,
            quote: quote || resolved.content.slice(0, 200),
        });
    }

    /** If the answer references markers that didn't survive validation,
     *  downgrade trust. Match `[N]` style markers — keep matching simple. */
    const verdict = downgradeIfBrokenMarkers(answer, citations, initialVerdict);

    return { answer, verdict, citations };
}

function downgradeIfBrokenMarkers(
    answer: string,
    citations: Citation[],
    current: Verdict,
): Verdict {
    if (current === 'no_evidence') return current;

    const markersInAnswer = new Set<string>();
    const re = /\[([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(answer)) !== null) markersInAnswer.add(match[1].trim());

    const markersAvailable = new Set(citations.map((c) => c.marker));
    for (const m of markersInAnswer) {
        if (!markersAvailable.has(m)) return 'uncertain';
    }
    return current;
}

function recordAndInvalidate(question: string, resultCount: number, started: number): void {
    logQuery({
        tool_name: 'ask',
        query_text: question,
        result_count: resultCount,
        latency_ms: Date.now() - started,
        session_id: null,
    });
    /** Profile's `learned.frequent_topics` + `recent_queries` are derived
     *  from `query_log`; cache must be busted so the next `profile()` read
     *  reflects this question. */
    invalidateProfile();
}
