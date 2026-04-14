import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';
import { extractArxiv } from '../../ingest/arxiv.js';

type ArxivConfig = {
    /** arXiv category (e.g. "cs.AI") or a full search query string. */
    query: string;
    /** Whether `query` is a raw category ("cs.AI") or a full Atom search expression. */
    query_kind: 'category' | 'raw';
    /** Max papers to consider per pull — bounds the extraction cost. */
    max_results: number;
};

type ArxivState = {
    seen_ids: string[];
    last_published: string | null;
};

const VALID_CATEGORY = /^[a-z]+(?:-[a-z]+)?\.[A-Z]{2,}$/;
const SEEN_IDS_LIMIT = 500;
const DEFAULT_MAX_RESULTS = 20;

export const arxivHandler: ConnectorHandler = {
    type: 'arxiv',

    parseTarget(target, options) {
        const trimmed = target.trim();
        if (!trimmed) throw new Error('arXiv connector target cannot be empty');

        let queryKind: 'category' | 'raw';
        let atomQuery: string;

        if (VALID_CATEGORY.test(trimmed)) {
            queryKind = 'category';
            atomQuery = `cat:${trimmed}`;
        } else {
            queryKind = 'raw';
            atomQuery = trimmed;
        }

        let maxResults = DEFAULT_MAX_RESULTS;
        if (options.max_results !== undefined) {
            const n = Number(options.max_results);
            if (!Number.isInteger(n) || n < 1 || n > 100) {
                throw new Error('arXiv --max-results must be an integer between 1 and 100');
            }
            maxResults = n;
        }

        const slug = trimmed
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();

        const config: ArxivConfig = {
            query: atomQuery,
            query_kind: queryKind,
            max_results: maxResults,
        };
        const initialState: ArxivState = { seen_ids: [], last_published: null };

        return {
            id: `arxiv:${slug}`,
            name: queryKind === 'category' ? `arXiv ${trimmed}` : `arXiv search: ${trimmed}`,
            config,
            initialState,
        };
    },

    async pull(connector: Connector): Promise<PullResult> {
        const config = parseConfig(connector.config);
        const state = parseState(connector.state);

        const apiUrl = buildApiUrl(config);
        const xml = await fetchAtomFeed(apiUrl);
        const entries = parseAtomEntries(xml);

        const seenIds = new Set(state.seen_ids);
        const newEntries = entries.filter((e) => !seenIds.has(e.arxivId));

        const items: ExtractionResult[] = [];
        for (const entry of newEntries) {
            try {
                const result = await extractArxiv(entry.arxivId);
                items.push(result);
            } catch {
                /** Skip papers that fail extraction — they'll be retried next pull. */
            }
        }

        const mergedIds = dedupePreserveOrder([
            ...entries.map((e) => e.arxivId),
            ...state.seen_ids,
        ]).slice(0, SEEN_IDS_LIMIT);

        const latestPublished = mostRecent(
            [state.last_published, ...entries.map((e) => e.published)].filter(
                (v): v is string => typeof v === 'string',
            ),
        );

        const newState: ArxivState = { seen_ids: mergedIds, last_published: latestPublished };
        return { new_items: items, new_state: newState };
    },
};

function parseConfig(raw: string): ArxivConfig {
    const parsed = JSON.parse(raw) as Partial<ArxivConfig>;
    if (typeof parsed.query !== 'string' || parsed.query.length === 0) {
        throw new Error('arXiv connector config missing "query"');
    }
    const queryKind = parsed.query_kind === 'raw' ? 'raw' : 'category';
    const maxResults =
        typeof parsed.max_results === 'number' && parsed.max_results > 0
            ? parsed.max_results
            : DEFAULT_MAX_RESULTS;
    return { query: parsed.query, query_kind: queryKind, max_results: maxResults };
}

function parseState(raw: string): ArxivState {
    try {
        const parsed = JSON.parse(raw) as Partial<ArxivState>;
        return {
            seen_ids: Array.isArray(parsed.seen_ids) ? parsed.seen_ids : [],
            last_published:
                typeof parsed.last_published === 'string' ? parsed.last_published : null,
        };
    } catch {
        return { seen_ids: [], last_published: null };
    }
}

function buildApiUrl(config: ArxivConfig): string {
    const params = new URLSearchParams({
        search_query: config.query,
        sortBy: 'submittedDate',
        sortOrder: 'descending',
        max_results: String(config.max_results),
    });
    return `https://export.arxiv.org/api/query?${params.toString()}`;
}

async function fetchAtomFeed(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumen/1.0)' },
        signal: AbortSignal.timeout(15000),
    }).catch((err: unknown) => {
        throw new Error(
            `arXiv API request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    if (!res.ok) {
        throw new Error(`arXiv API returned ${res.status} ${res.statusText}`);
    }
    return res.text();
}

type ArxivEntry = {
    arxivId: string;
    title: string;
    published: string | null;
};

function parseAtomEntries(xml: string): ArxivEntry[] {
    /** Minimal Atom parser — arXiv's format is stable and small. Matches one
     *  `<entry>…</entry>` block at a time, extracts id/title/published. */
    const entries: ArxivEntry[] = [];
    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

    for (const block of entryBlocks) {
        const idMatch = block.match(/<id>([^<]+)<\/id>/);
        if (!idMatch) continue;

        const arxivId = parseArxivIdFromUrl(idMatch[1]);
        if (!arxivId) continue;

        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
        const publishedMatch = block.match(/<published>([^<]+)<\/published>/);

        entries.push({
            arxivId,
            title: titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : `arXiv:${arxivId}`,
            published: publishedMatch ? publishedMatch[1].trim() : null,
        });
    }
    return entries;
}

function parseArxivIdFromUrl(raw: string): string | null {
    /** The Atom `<id>` is like "http://arxiv.org/abs/2403.12345v1" — strip
     *  prefix and version suffix. */
    const match = raw.match(/arxiv\.org\/abs\/([\w./-]+?)(?:v\d+)?$/);
    return match ? match[1] : null;
}

function dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

function mostRecent(isoDates: string[]): string | null {
    let max: string | null = null;
    for (const d of isoDates) {
        if (!max || d > max) max = d;
    }
    return max;
}
