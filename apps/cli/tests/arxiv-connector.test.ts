import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Mocks MUST be declared before importing the handler under test. */
const extractCalls: string[] = [];
vi.mock('../src/ingest/arxiv.js', () => ({
    extractArxiv: async (id: string) => {
        extractCalls.push(id);
        return {
            title: `Paper ${id}`,
            content: `Full body for arXiv paper ${id} with plenty of words.`,
            url: `https://arxiv.org/abs/${id}`,
            source_type: 'arxiv',
            language: 'en',
            metadata: { arxiv_id: id },
        };
    },
}));

import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertConnector, getConnector } from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler } from '../src/connectors/registry.js';
import { arxivHandler } from '../src/connectors/handlers/arxiv.js';
import type { Connector } from '../src/types/index.js';

let tempDir: string;

function mockFetchWithEntries(entries: Array<{ id: string; title?: string; published?: string }>) {
    const xml =
        '<feed>' +
        entries
            .map(
                (e) =>
                    `<entry>
                        <id>http://arxiv.org/abs/${e.id}v1</id>
                        <title>${e.title ?? 'Untitled'}</title>
                        <published>${e.published ?? '2026-04-14T00:00:00Z'}</published>
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
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-arxiv-conn-'));
    setDataDir(tempDir);
    getDb();
    registerHandler(arxivHandler);
    extractCalls.length = 0;
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function seedConnector(overrides: Partial<Connector> = {}): Connector {
    const c: Connector = {
        id: 'arxiv:cs-ai',
        type: 'arxiv',
        name: 'arXiv cs.AI',
        config: JSON.stringify({ query: 'cat:cs.AI', query_kind: 'category', max_results: 20 }),
        state: JSON.stringify({ seen_ids: [], last_published: null }),
        interval_seconds: 86400,
        last_run_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
    insertConnector(c);
    return c;
}

describe('arxivHandler.parseTarget', () => {
    it('treats cs.AI-style inputs as category queries', () => {
        const result = arxivHandler.parseTarget('cs.AI', {});
        expect(result.id).toBe('arxiv:cs-ai');
        expect(result.config).toMatchObject({ query: 'cat:cs.AI', query_kind: 'category' });
    });

    it('accepts multi-segment categories like math.DS', () => {
        const result = arxivHandler.parseTarget('math.DS', {});
        expect((result.config as { query: string }).query).toBe('cat:math.DS');
    });

    it('falls back to raw query for arbitrary search strings', () => {
        const result = arxivHandler.parseTarget('transformer attention', {});
        expect((result.config as { query: string }).query).toBe('transformer attention');
        expect((result.config as { query_kind: string }).query_kind).toBe('raw');
    });

    it('rejects empty targets', () => {
        expect(() => arxivHandler.parseTarget('   ', {})).toThrow(/cannot be empty/);
    });

    it('rejects out-of-range max_results', () => {
        expect(() => arxivHandler.parseTarget('cs.AI', { max_results: 500 })).toThrow();
        expect(() => arxivHandler.parseTarget('cs.AI', { max_results: 0 })).toThrow();
    });
});

describe('arxivHandler.pull', () => {
    it('ingests new papers and extracts each via extractArxiv', async () => {
        mockFetchWithEntries([
            { id: '2404.00001', title: 'Paper A', published: '2026-04-13T12:00:00Z' },
            { id: '2404.00002', title: 'Paper B', published: '2026-04-14T12:00:00Z' },
        ]);
        seedConnector();

        const result = await runConnector(getConnector('arxiv:cs-ai')!);
        expect(result.error).toBeNull();
        expect(result.fetched).toBe(2);
        expect(result.ingested).toBe(2);
        expect(extractCalls).toEqual(['2404.00001', '2404.00002']);

        const state = JSON.parse(getConnector('arxiv:cs-ai')!.state) as {
            seen_ids: string[];
            last_published: string;
        };
        expect(state.seen_ids).toEqual(expect.arrayContaining(['2404.00001', '2404.00002']));
        expect(state.last_published).toBe('2026-04-14T12:00:00Z');
    });

    it('skips already-seen ids on subsequent pulls', async () => {
        mockFetchWithEntries([{ id: '2404.00001' }]);
        seedConnector({
            state: JSON.stringify({ seen_ids: ['2404.00001'], last_published: null }),
        });

        const result = await runConnector(getConnector('arxiv:cs-ai')!);
        expect(result.fetched).toBe(0);
        expect(extractCalls).toEqual([]);
    });

    it('records failure if arXiv API returns non-200', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => '',
        }) as unknown as typeof fetch;
        seedConnector();

        const result = await runConnector(getConnector('arxiv:cs-ai')!);
        expect(result.error).toMatch(/503/);
    });
});
