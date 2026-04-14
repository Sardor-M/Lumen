import { extract as extractFeed } from '@extractus/feed-extractor';
import { extract as extractArticle } from '@extractus/article-extractor';
import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';

type RssConfig = {
    url: string;
    fetch_article_body?: boolean;
};

type RssState = {
    seen_ids: string[];
    last_published: string | null;
};

type FeedEntry = {
    id?: string;
    title?: string;
    link?: string;
    description?: string;
    published?: string;
    author?: string;
};

/** Hard cap on how many seen IDs we remember — keeps the state row small even
 *  for feeds that rotate rapidly. 500 is generous for any weekly/daily feed. */
const SEEN_IDS_LIMIT = 500;

/** feed-extractor delegates to fast-xml-parser, which ships with conservative
 *  anti-XML-bomb limits (maxTotalExpansions=1000). Large Atom feeds with many
 *  HTML-encoded entities (e.g. simonwillison.net) blow past this. Since the
 *  URL is user-supplied and the output is stored as text, relax the limits. */
const FEED_XML_PARSER_OPTIONS = {
    processEntities: {
        enabled: true,
        maxTotalExpansions: 100_000,
        maxExpandedLength: 10_000_000,
        maxEntityCount: 10_000,
    },
};

export const rssHandler: ConnectorHandler = {
    type: 'rss',

    parseTarget(target, options) {
        let url: URL;
        try {
            url = new URL(target);
        } catch {
            throw new Error(`Invalid RSS feed URL: ${target}`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error(`RSS feed URL must be http/https, got: ${url.protocol}`);
        }

        const slug = `${url.hostname}${url.pathname}`
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();

        const config: RssConfig = {
            url: target,
            fetch_article_body: options.fetch_article_body !== false,
        };
        const initialState: RssState = { seen_ids: [], last_published: null };

        return {
            id: `rss:${slug}`,
            name: `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
            config,
            initialState,
        };
    },

    async pull(connector: Connector): Promise<PullResult> {
        const config = JSON.parse(connector.config) as RssConfig;
        const state = parseState(connector.state);

        const feed = await extractFeed(config.url, {
            xmlParserOptions: FEED_XML_PARSER_OPTIONS,
        }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to fetch RSS feed ${config.url}: ${msg}`);
        });

        /** feed-extractor returns `{ entries: [...] }`. Type cast because the
         *  library's types are permissive. */
        const entries = ((feed as { entries?: FeedEntry[] })?.entries ?? []).filter(
            (e): e is FeedEntry => typeof e === 'object' && e !== null,
        );

        const seenIds = new Set(state.seen_ids);
        const newEntries = entries.filter((e) => {
            const id = entryId(e);
            return !seenIds.has(id);
        });

        const items: ExtractionResult[] = [];
        for (const entry of newEntries) {
            const item = await entryToExtraction(entry, config.fetch_article_body !== false);
            if (item) items.push(item);
        }

        /** Advance cursor: union of old seen_ids + every id observed in this
         *  fetch, truncated to the most recent SEEN_IDS_LIMIT. Tracks by id
         *  (not just published date) because some feeds don't set published. */
        const allIdsThisPull = entries.map(entryId);
        const mergedIds = dedupePreserveOrder([...allIdsThisPull, ...state.seen_ids]).slice(
            0,
            SEEN_IDS_LIMIT,
        );

        const latestPublished = mostRecent(
            [state.last_published, ...entries.map((e) => e.published ?? null)].filter(
                (v): v is string => typeof v === 'string',
            ),
        );

        const newState: RssState = {
            seen_ids: mergedIds,
            last_published: latestPublished,
        };

        return { new_items: items, new_state: newState };
    },
};

function parseState(raw: string): RssState {
    try {
        const parsed = JSON.parse(raw) as Partial<RssState>;
        return {
            seen_ids: Array.isArray(parsed.seen_ids) ? parsed.seen_ids : [],
            last_published:
                typeof parsed.last_published === 'string' ? parsed.last_published : null,
        };
    } catch {
        return { seen_ids: [], last_published: null };
    }
}

function entryId(entry: FeedEntry): string {
    return entry.id ?? entry.link ?? entry.title ?? '';
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

async function entryToExtraction(
    entry: FeedEntry,
    fetchArticleBody: boolean,
): Promise<ExtractionResult | null> {
    const title = entry.title?.trim() || 'Untitled';
    const link = entry.link ?? null;

    /** Prefer the full article body fetched via article-extractor; fall back
     *  to the feed-supplied description/summary. If both are empty, skip. */
    let content = '';
    if (fetchArticleBody && link) {
        const article = await extractArticle(link).catch(() => null);
        if (article?.content) content = article.content;
    }
    if (!content) content = (entry.description ?? '').trim();
    if (!content) return null;

    return {
        title,
        content,
        url: link,
        source_type: 'url',
        language: null,
        metadata: {
            rss_id: entry.id ?? null,
            author: entry.author ?? null,
            published: entry.published ?? null,
        },
    };
}
