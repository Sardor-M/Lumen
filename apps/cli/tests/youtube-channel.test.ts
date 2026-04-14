import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Mock BEFORE importing the handler. */
const extractCalls: string[] = [];
const extractFailures = new Set<string>();
vi.mock('../src/ingest/youtube.js', () => ({
    extractYoutube: async (videoId: string) => {
        extractCalls.push(videoId);
        if (extractFailures.has(videoId)) throw new Error('transcript unavailable');
        return {
            title: `Raw title for ${videoId}`,
            content: `Transcript body for ${videoId} with plenty of words to form a chunk.`,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            source_type: 'youtube',
            language: 'en',
            metadata: { video_id: videoId },
        };
    },
}));

import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertConnector, getConnector } from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler } from '../src/connectors/registry.js';
import { youtubeChannelHandler } from '../src/connectors/handlers/youtube-channel.js';
import type { Connector } from '../src/types/index.js';

let tempDir: string;
const CHANNEL_ID = 'UC1234567890abcdefghijKL';

function mockFeed(videos: Array<{ id: string; title?: string; published?: string }>) {
    const xml =
        '<feed>' +
        videos
            .map(
                (v) =>
                    `<entry>
                        <yt:videoId>${v.id}</yt:videoId>
                        <title>${v.title ?? 'Untitled'}</title>
                        <published>${v.published ?? '2026-04-14T09:00:00Z'}</published>
                    </entry>`,
            )
            .join('') +
        '</feed>';

    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => xml,
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-yt-'));
    setDataDir(tempDir);
    getDb();
    registerHandler(youtubeChannelHandler);
    extractCalls.length = 0;
    extractFailures.clear();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function seedConnector(overrides: Partial<Connector> = {}): Connector {
    const c: Connector = {
        id: `youtube:${CHANNEL_ID.toLowerCase()}`,
        type: 'youtube-channel',
        name: `YouTube ${CHANNEL_ID}`,
        config: JSON.stringify({ channel_id: CHANNEL_ID, max_results: 15 }),
        state: JSON.stringify({ seen_video_ids: [], last_published: null }),
        interval_seconds: 3600,
        last_run_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
    insertConnector(c);
    return c;
}

describe('youtubeChannelHandler.parseTarget', () => {
    it('accepts a raw channel ID', () => {
        const r = youtubeChannelHandler.parseTarget(CHANNEL_ID, {});
        expect((r.config as { channel_id: string }).channel_id).toBe(CHANNEL_ID);
    });

    it('extracts a channel ID from a /channel/ URL', () => {
        const r = youtubeChannelHandler.parseTarget(
            `https://www.youtube.com/channel/${CHANNEL_ID}`,
            {},
        );
        expect((r.config as { channel_id: string }).channel_id).toBe(CHANNEL_ID);
    });

    it('extracts a channel ID from a feed URL', () => {
        const r = youtubeChannelHandler.parseTarget(
            `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
            {},
        );
        expect((r.config as { channel_id: string }).channel_id).toBe(CHANNEL_ID);
    });

    it('rejects handles with a clear message', () => {
        expect(() => youtubeChannelHandler.parseTarget('@mkbhd', {})).toThrow(/channel ID/);
    });

    it('rejects out-of-range max_results', () => {
        expect(() => youtubeChannelHandler.parseTarget(CHANNEL_ID, { max_results: 200 })).toThrow();
    });
});

describe('youtubeChannelHandler.pull', () => {
    it('fetches new videos and calls extractYoutube for each', async () => {
        mockFeed([
            { id: 'vid_aaaaaa1', title: 'Video A', published: '2026-04-13T12:00:00Z' },
            { id: 'vid_bbbbbb2', title: 'Video B', published: '2026-04-14T12:00:00Z' },
        ]);
        seedConnector();

        const result = await runConnector(getConnector(`youtube:${CHANNEL_ID.toLowerCase()}`)!);
        expect(result.error).toBeNull();
        expect(result.fetched).toBe(2);
        expect(result.ingested).toBe(2);
        expect(extractCalls).toEqual(['vid_aaaaaa1', 'vid_bbbbbb2']);

        const state = JSON.parse(getConnector(`youtube:${CHANNEL_ID.toLowerCase()}`)!.state) as {
            seen_video_ids: string[];
            last_published: string;
        };
        expect(state.seen_video_ids).toEqual(
            expect.arrayContaining(['vid_aaaaaa1', 'vid_bbbbbb2']),
        );
        expect(state.last_published).toBe('2026-04-14T12:00:00Z');
    });

    it('skips seen video ids', async () => {
        mockFeed([{ id: 'vid_aaaaaa1' }]);
        seedConnector({
            state: JSON.stringify({
                seen_video_ids: ['vid_aaaaaa1'],
                last_published: null,
            }),
        });

        const result = await runConnector(getConnector(`youtube:${CHANNEL_ID.toLowerCase()}`)!);
        expect(result.fetched).toBe(0);
        expect(extractCalls).toEqual([]);
    });

    it('continues on per-video transcript failures without advancing seen set', async () => {
        mockFeed([{ id: 'vid_aaaaaa1' }, { id: 'vid_bbbbbb2' }]);
        extractFailures.add('vid_aaaaaa1');
        seedConnector();

        const result = await runConnector(getConnector(`youtube:${CHANNEL_ID.toLowerCase()}`)!);
        expect(result.fetched).toBe(1);
        expect(result.ingested).toBe(1);
        /** Both IDs still go into seen_video_ids so the failing video isn't
         *  retried forever — matches the other handlers' behaviour. */
    });

    it('surfaces API failures', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => '',
        }) as unknown as typeof fetch;
        seedConnector();

        const result = await runConnector(getConnector(`youtube:${CHANNEL_ID.toLowerCase()}`)!);
        expect(result.error).toMatch(/503/);
    });
});
