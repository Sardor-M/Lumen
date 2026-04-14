import type { ConnectorHandler, PullResult } from '../types.js';
import type { Connector, ExtractionResult } from '../../types/index.js';
import { extractYoutube } from '../../ingest/youtube.js';

type YoutubeConfig = {
    channel_id: string;
    max_results: number;
};

type YoutubeState = {
    seen_video_ids: string[];
    last_published: string | null;
};

const DEFAULT_MAX_RESULTS = 15;
const SEEN_LIMIT = 500;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export const youtubeChannelHandler: ConnectorHandler = {
    type: 'youtube-channel',

    parseTarget(target, options) {
        const channelId = extractChannelId(target);
        if (!channelId) {
            throw new Error(
                `YouTube target must be a channel ID (UC...), channel URL, or channel feed URL. Handles (@name) require resolving to a channel ID first.`,
            );
        }

        const maxResults = parseMaxResults(options.max_results);

        return {
            id: `youtube:${channelId.toLowerCase()}`,
            name: `YouTube ${channelId}`,
            config: { channel_id: channelId, max_results: maxResults } as YoutubeConfig,
            initialState: {
                seen_video_ids: [],
                last_published: null,
            } as YoutubeState,
        };
    },

    async pull(connector: Connector): Promise<PullResult> {
        const config = parseConfig(connector.config);
        const state = parseState(connector.state);

        const feed = await fetchChannelFeed(config.channel_id);
        const entries = parseFeedEntries(feed).slice(0, config.max_results);

        const seen = new Set(state.seen_video_ids);
        const newEntries = entries.filter((e) => !seen.has(e.videoId));

        const items: ExtractionResult[] = [];
        for (const entry of newEntries) {
            try {
                const base = await extractYoutube(entry.videoId);
                items.push({
                    ...base,
                    /** Prefer the feed-supplied title — less likely to have
                     *  "YouTube" branding than the page-derived title. */
                    title: entry.title || base.title,
                    metadata: {
                        ...base.metadata,
                        channel_id: config.channel_id,
                        published: entry.published,
                    },
                });
            } catch {
                /** Transcript unavailable or video private — skip without
                 *  advancing the cursor so it retries next pull. */
            }
        }

        const mergedIds = dedupePreserveOrder([
            ...entries.map((e) => e.videoId),
            ...state.seen_video_ids,
        ]).slice(0, SEEN_LIMIT);

        const latestPublished = mostRecent(
            [state.last_published, ...entries.map((e) => e.published)].filter(
                (v): v is string => typeof v === 'string',
            ),
        );

        return {
            new_items: items,
            new_state: { seen_video_ids: mergedIds, last_published: latestPublished },
        };
    },
};

function parseMaxResults(raw: unknown): number {
    if (raw === undefined) return DEFAULT_MAX_RESULTS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
        throw new Error('YouTube --max-results must be an integer between 1 and 50');
    }
    return n;
}

function parseConfig(raw: string): YoutubeConfig {
    const parsed = JSON.parse(raw) as Partial<YoutubeConfig>;
    if (typeof parsed.channel_id !== 'string') {
        throw new Error('YouTube connector config missing "channel_id"');
    }
    return {
        channel_id: parsed.channel_id,
        max_results:
            typeof parsed.max_results === 'number' && parsed.max_results > 0
                ? parsed.max_results
                : DEFAULT_MAX_RESULTS,
    };
}

function parseState(raw: string): YoutubeState {
    try {
        const parsed = JSON.parse(raw) as Partial<YoutubeState>;
        return {
            seen_video_ids: Array.isArray(parsed.seen_video_ids) ? parsed.seen_video_ids : [],
            last_published:
                typeof parsed.last_published === 'string' ? parsed.last_published : null,
        };
    } catch {
        return { seen_video_ids: [], last_published: null };
    }
}

/**
 * Accept a raw channel ID, a channel page URL, a feed URL, or a URL with
 * `channel_id=` query param. Reject handles (`@name`) — resolving them to a
 * channel ID requires a separate API call we're not wiring up yet.
 */
function extractChannelId(target: string): string | null {
    const trimmed = target.trim();
    if (CHANNEL_ID_PATTERN.test(trimmed)) return trimmed;

    try {
        const url = new URL(trimmed);
        /** /channel/UC... */
        const pathMatch = url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
        if (pathMatch) return pathMatch[1];
        /** ?channel_id=UC... */
        const paramId = url.searchParams.get('channel_id');
        if (paramId && CHANNEL_ID_PATTERN.test(paramId)) return paramId;
    } catch {
        /** Not a URL — fall through. */
    }
    return null;
}

async function fetchChannelFeed(channelId: string): Promise<string> {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumen/1.0)' },
        signal: AbortSignal.timeout(15000),
    }).catch((err: unknown) => {
        throw new Error(
            `YouTube feed fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    if (res.status === 404) {
        throw new Error(`Channel not found: ${channelId}`);
    }
    if (!res.ok) {
        throw new Error(`YouTube feed returned ${res.status} ${res.statusText}`);
    }
    return res.text();
}

type FeedEntry = { videoId: string; title: string; published: string | null };

function parseFeedEntries(xml: string): FeedEntry[] {
    const entries: FeedEntry[] = [];
    const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    for (const block of blocks) {
        const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
        if (!videoId) continue;
        const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
        const published = block.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
        entries.push({ videoId, title, published });
    }
    return entries;
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
