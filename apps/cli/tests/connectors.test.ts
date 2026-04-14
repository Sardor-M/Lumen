import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    insertConnector,
    getConnector,
    listConnectors,
    deleteConnector,
    countConnectors,
    recordRunSuccess,
    recordRunFailure,
    dueConnectors,
} from '../src/store/connectors.js';
import { runConnector } from '../src/connectors/runner.js';
import { registerHandler, getHandler } from '../src/connectors/registry.js';
import type { Connector } from '../src/types/index.js';
import type { ConnectorHandler, PullResult } from '../src/connectors/types.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-connectors-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

function fixture(overrides: Partial<Connector> = {}): Connector {
    return {
        id: 'rss:example',
        type: 'rss',
        name: 'Example feed',
        config: JSON.stringify({ url: 'https://example.com/feed' }),
        state: '{}',
        interval_seconds: 3600,
        last_run_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

describe('store/connectors', () => {
    it('insert + get round-trips all fields', () => {
        insertConnector(fixture());
        const c = getConnector('rss:example');
        expect(c).not.toBeNull();
        expect(c?.type).toBe('rss');
        expect(c?.name).toBe('Example feed');
        expect(JSON.parse(c!.config)).toEqual({ url: 'https://example.com/feed' });
    });

    it('list returns newest first, filters by type', () => {
        insertConnector(fixture({ id: 'rss:a', created_at: '2026-01-01T00:00:00Z' }));
        insertConnector(fixture({ id: 'rss:b', created_at: '2026-01-02T00:00:00Z' }));
        insertConnector(
            fixture({ id: 'folder:c', type: 'folder', created_at: '2026-01-03T00:00:00Z' }),
        );

        const all = listConnectors();
        expect(all.map((c) => c.id)).toEqual(['folder:c', 'rss:b', 'rss:a']);

        const rssOnly = listConnectors({ type: 'rss' });
        expect(rssOnly.map((c) => c.id)).toEqual(['rss:b', 'rss:a']);
    });

    it('delete returns false for missing id, true for existing', () => {
        insertConnector(fixture());
        expect(deleteConnector('rss:does-not-exist')).toBe(false);
        expect(deleteConnector('rss:example')).toBe(true);
        expect(countConnectors()).toBe(0);
    });

    it('recordRunSuccess updates state and clears error', () => {
        insertConnector(fixture({ last_error: 'prior failure' }));
        recordRunSuccess('rss:example', { cursor: 'xyz' });
        const c = getConnector('rss:example');
        expect(JSON.parse(c!.state)).toEqual({ cursor: 'xyz' });
        expect(c?.last_run_at).toBeTruthy();
        expect(c?.last_error).toBeNull();
    });

    it('recordRunFailure preserves state but sets error', () => {
        insertConnector(fixture({ state: JSON.stringify({ cursor: 'keep-me' }) }));
        recordRunFailure('rss:example', 'network timeout');
        const c = getConnector('rss:example');
        expect(JSON.parse(c!.state)).toEqual({ cursor: 'keep-me' });
        expect(c?.last_error).toBe('network timeout');
    });

    it('dueConnectors returns never-run connectors and those past their interval', () => {
        const now = new Date('2026-04-14T12:00:00Z');
        insertConnector(fixture({ id: 'never-run' }));
        insertConnector(
            fixture({
                id: 'recent',
                last_run_at: '2026-04-14T11:30:00Z',
                interval_seconds: 3600,
            }),
        );
        insertConnector(
            fixture({
                id: 'stale',
                last_run_at: '2026-04-14T10:30:00Z',
                interval_seconds: 3600,
            }),
        );

        const due = dueConnectors(now).map((c) => c.id);
        expect(due).toContain('never-run');
        expect(due).toContain('stale');
        expect(due).not.toContain('recent');
    });
});

describe('connectors/runner', () => {
    it('runs a handler, ingests new items, dedupes repeats, advances cursor', async () => {
        const fakeHandler: ConnectorHandler = {
            type: 'rss',
            parseTarget() {
                return { id: 'rss:fake', name: 'Fake', config: {}, initialState: {} };
            },
            pull: async (): Promise<PullResult> => ({
                new_items: [
                    {
                        title: 'Post 1',
                        content: 'First post body with enough words to be a real chunk.',
                        url: 'https://example.com/1',
                        source_type: 'url',
                        language: 'en',
                        metadata: {},
                    },
                    {
                        title: 'Post 2',
                        content: 'Second post body also with several words of content.',
                        url: 'https://example.com/2',
                        source_type: 'url',
                        language: 'en',
                        metadata: {},
                    },
                ],
                new_state: { cursor: 'latest-id' },
            }),
        };
        registerHandler(fakeHandler);

        insertConnector(fixture({ id: 'rss:fake' }));
        const first = await runConnector(getConnector('rss:fake')!);
        expect(first.error).toBeNull();
        expect(first.fetched).toBe(2);
        expect(first.ingested).toBe(2);
        expect(first.deduped).toBe(0);

        /** Second run with the same items — both should dedupe. */
        const second = await runConnector(getConnector('rss:fake')!);
        expect(second.fetched).toBe(2);
        expect(second.ingested).toBe(0);
        expect(second.deduped).toBe(2);

        /** Cursor advanced. */
        const saved = getConnector('rss:fake');
        expect(JSON.parse(saved!.state)).toEqual({ cursor: 'latest-id' });
    });

    it('records failure state when handler throws', async () => {
        const failing: ConnectorHandler = {
            type: 'rss',
            parseTarget() {
                return { id: 'rss:fail', name: 'Fail', config: {}, initialState: {} };
            },
            pull: async () => {
                throw new Error('handler boom');
            },
        };
        registerHandler(failing);

        insertConnector(
            fixture({ id: 'rss:fail', state: JSON.stringify({ cursor: 'preserved' }) }),
        );
        const result = await runConnector(getConnector('rss:fail')!);

        expect(result.error).toBe('handler boom');
        const saved = getConnector('rss:fail');
        expect(saved?.last_error).toBe('handler boom');
        /** State must NOT advance on failure. */
        expect(JSON.parse(saved!.state)).toEqual({ cursor: 'preserved' });
    });

    it('returns an error without crashing when no handler is registered', async () => {
        insertConnector(fixture({ id: 'rss:unregistered', type: 'github' }));
        const result = await runConnector(getConnector('rss:unregistered')!);
        expect(result.error).toMatch(/No handler registered/);
    });

    it('registry lookup returns null for unknown types', () => {
        expect(getHandler('youtube-channel')).toBeNull();
    });
});
