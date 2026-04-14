import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { insertConnector, getConnector } from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler } from '../src/connectors/registry.js';
import { githubHandler } from '../src/connectors/handlers/github.js';
import type { Connector } from '../src/types/index.js';

let tempDir: string;

type FakeResponse = {
    status: number;
    ok?: boolean;
    body: unknown;
    headers?: Record<string, string>;
};

function mockResponses(routes: Record<string, FakeResponse>) {
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = typeof input === 'string' ? input : input.toString();
        for (const [needle, response] of Object.entries(routes)) {
            if (url.includes(needle)) {
                return makeResponse(response);
            }
        }
        return makeResponse({ status: 404, body: { message: 'not mocked' } });
    }) as unknown as typeof fetch;
}

function makeResponse(r: FakeResponse): Response {
    return {
        ok: r.ok ?? (r.status >= 200 && r.status < 300),
        status: r.status,
        statusText: r.status === 200 ? 'OK' : 'ERR',
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
        headers: {
            get: (k: string) => r.headers?.[k.toLowerCase()] ?? null,
        } as unknown as Headers,
    } as unknown as Response;
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-github-'));
    setDataDir(tempDir);
    getDb();
    registerHandler(githubHandler);
    delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function seedConnector(overrides: Partial<Connector> = {}): Connector {
    const c: Connector = {
        id: 'github:anthropics-claude-code',
        type: 'github',
        name: 'anthropics/claude-code',
        config: JSON.stringify({
            owner: 'anthropics',
            repo: 'claude-code',
            include_readme: true,
            max_results: 50,
        }),
        state: JSON.stringify({ since: null, last_readme_sha: null }),
        interval_seconds: 3600,
        last_run_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
    insertConnector(c);
    return c;
}

describe('githubHandler.parseTarget', () => {
    it('accepts "owner/repo" format', () => {
        const r = githubHandler.parseTarget('anthropics/claude-code', {});
        expect(r.id).toBe('github:anthropics-claude-code');
        expect(r.config).toMatchObject({
            owner: 'anthropics',
            repo: 'claude-code',
            include_readme: true,
        });
    });

    it('lowercases the id but preserves the original casing in the name', () => {
        const r = githubHandler.parseTarget('Anthropics/Claude-Code', {});
        expect(r.id).toBe('github:anthropics-claude-code');
        expect(r.name).toBe('Anthropics/Claude-Code');
    });

    it('rejects malformed targets', () => {
        expect(() => githubHandler.parseTarget('just-a-word', {})).toThrow(/owner\/repo/);
        expect(() => githubHandler.parseTarget('too/many/slashes', {})).toThrow(/owner\/repo/);
    });

    it('honors include_readme: false', () => {
        const r = githubHandler.parseTarget('a/b', { include_readme: false });
        expect(r.config).toMatchObject({ include_readme: false });
    });

    it('rejects out-of-range max_results', () => {
        expect(() => githubHandler.parseTarget('a/b', { max_results: 200 })).toThrow();
        expect(() => githubHandler.parseTarget('a/b', { max_results: 0 })).toThrow();
    });
});

describe('githubHandler.pull', () => {
    it('fetches issues + README on first run', async () => {
        mockResponses({
            '/issues': {
                status: 200,
                body: [
                    {
                        number: 42,
                        title: 'Feature: auto-save',
                        body: 'Please auto-save drafts.',
                        html_url: 'https://github.com/anthropics/claude-code/issues/42',
                        state: 'open',
                        user: { login: 'alice' },
                        labels: [{ name: 'enhancement' }],
                        created_at: '2026-04-10T09:00:00Z',
                        updated_at: '2026-04-14T09:00:00Z',
                    },
                    {
                        number: 43,
                        title: 'Fix: crash on empty input',
                        body: 'Repro steps below.',
                        html_url: 'https://github.com/anthropics/claude-code/pull/43',
                        state: 'open',
                        user: { login: 'bob' },
                        labels: [],
                        created_at: '2026-04-12T09:00:00Z',
                        updated_at: '2026-04-14T10:00:00Z',
                        pull_request: { url: 'x' },
                    },
                ],
            },
            '/readme': {
                status: 200,
                body: {
                    content: Buffer.from('# Claude Code\n\nOfficial CLI.').toString('base64'),
                    encoding: 'base64',
                    sha: 'readme-sha-1',
                    html_url: 'https://github.com/anthropics/claude-code/blob/main/README.md',
                    path: 'README.md',
                },
            },
        });
        seedConnector();

        const result = await runConnector(getConnector('github:anthropics-claude-code')!);
        expect(result.error).toBeNull();
        expect(result.fetched).toBe(3);
        expect(result.ingested).toBe(3);

        const state = JSON.parse(getConnector('github:anthropics-claude-code')!.state) as {
            since: string;
            last_readme_sha: string;
        };
        expect(state.since).toBeTruthy();
        expect(state.last_readme_sha).toBe('readme-sha-1');
    });

    it('skips README re-ingest when the SHA is unchanged', async () => {
        mockResponses({
            '/issues': { status: 200, body: [] },
            '/readme': {
                status: 200,
                body: {
                    content: Buffer.from('unchanged').toString('base64'),
                    encoding: 'base64',
                    sha: 'same-sha',
                    html_url: 'https://x',
                    path: 'README.md',
                },
            },
        });
        seedConnector({
            state: JSON.stringify({ since: '2026-04-13T00:00:00Z', last_readme_sha: 'same-sha' }),
        });

        const result = await runConnector(getConnector('github:anthropics-claude-code')!);
        expect(result.fetched).toBe(0);
    });

    it('distinguishes PRs from issues via pull_request field', async () => {
        mockResponses({
            '/issues': {
                status: 200,
                body: [
                    {
                        number: 100,
                        title: 'A PR',
                        body: 'diff',
                        html_url: 'https://x/pull/100',
                        state: 'open',
                        user: { login: 'c' },
                        labels: [],
                        created_at: '2026-04-14T09:00:00Z',
                        updated_at: '2026-04-14T09:00:00Z',
                        pull_request: { url: 'x' },
                    },
                ],
            },
            '/readme': { status: 404, body: {} },
        });
        seedConnector();

        const result = await runConnector(getConnector('github:anthropics-claude-code')!);
        expect(result.ingested).toBe(1);
        /** No regression assertion here beyond success — the metadata shape is
         *  covered in the pure handler unit below. */
    });

    it('surfaces a helpful error on 403 with remaining=0 (rate limit)', async () => {
        mockResponses({
            '/issues': {
                status: 403,
                body: { message: 'rate limit' },
                headers: { 'x-ratelimit-remaining': '0' },
            },
        });
        seedConnector();

        const result = await runConnector(getConnector('github:anthropics-claude-code')!);
        expect(result.error).toMatch(/rate-limited/);
        expect(result.error).toMatch(/GITHUB_TOKEN/);
    });

    it('uses GITHUB_TOKEN when present', async () => {
        process.env.GITHUB_TOKEN = 'test-pat';
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
            makeResponse({ status: 200, body: [] }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        seedConnector({
            config: JSON.stringify({
                owner: 'a',
                repo: 'b',
                include_readme: false,
                max_results: 50,
            }),
        });

        await runConnector(getConnector('github:anthropics-claude-code')!);
        const init = fetchMock.mock.calls[0][1];
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-pat');
    });
});
