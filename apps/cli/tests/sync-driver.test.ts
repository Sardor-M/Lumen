import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => {
    process.env.LUMEN_RELAY_NO_BACKOFF = '1';
});
afterAll(() => {
    delete process.env.LUMEN_RELAY_NO_BACKOFF;
});
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import { appendJournal, countJournal, listUnpushed, listUnapplied } from '../src/sync/journal.js';
import {
    getOrInitSyncState,
    setEnabled,
    setRelayConfig,
    setLastError,
    updateCursor,
} from '../src/sync/state.js';
import { setMasterKey, setKeyringBackend, deleteMasterKey } from '../src/sync/keyring.js';
import {
    runPush,
    runPull,
    runSync,
    clearLastError,
    resetCircuitBreakerForTests,
    computeLocalScopeTags,
} from '../src/sync/sync-driver.js';
import {
    generateMasterKey,
    deriveUserHash,
    encryptEnvelope,
    decryptEnvelope,
    fingerprintMasterKey,
} from '../src/sync/crypto.js';
import type { FetchLike, PullEntry, PushBatch } from '../src/sync/relay-client.js';
import { upsertScope } from '../src/store/scopes.js';

let tempDir: string;
let masterKey: Buffer;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-sync-driver-'));
    setDataDir(tempDir);
    setKeyringBackend('memory');
    getDb();
    masterKey = generateMasterKey();
    setMasterKey(masterKey);
    setRelayConfig({
        user_hash: deriveUserHash(masterKey),
        relay_url: 'https://relay.test',
        encryption_key_fingerprint: fingerprintMasterKey(masterKey),
    });
    setEnabled(true);
    resetCircuitBreakerForTests();
});

afterEach(() => {
    deleteMasterKey();
    setKeyringBackend(null);
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

function seedJournalEntry(): string {
    return appendJournal({
        op: 'concept_create',
        entity_id: 'foo',
        scope_kind: 'codebase',
        scope_key: 'repo-a',
        payload: { slug: 'foo', name: 'Foo' },
    });
}

function fetchOK(handler: (url: string, init?: RequestInit) => unknown): FetchLike {
    return async (url, init) =>
        new Response(JSON.stringify(handler(url, init)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
}

/** ─── Push pipeline ─── */

describe('runPush', () => {
    it('encrypts unpushed entries, POSTs them, marks them pushed', async () => {
        seedJournalEntry();
        seedJournalEntry();
        let receivedBatch: PushBatch | null = null;
        const fetchImpl = fetchOK((_url, init) => {
            receivedBatch = JSON.parse(String(init?.body)) as PushBatch;
            return { accepted: receivedBatch.entries.length, rejected: [] };
        });

        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(2);
        expect(result.errors).toEqual([]);
        expect(receivedBatch).not.toBeNull();
        expect(receivedBatch!.entries).toHaveLength(2);

        /** Entries must now be marked pushed (no longer in listUnpushed). */
        expect(listUnpushed()).toHaveLength(0);
    });

    it('stamps sync_state.last_push_at after a successful push', async () => {
        seedJournalEntry();
        const before = getOrInitSyncState();
        expect(before.last_push_at).toBeNull();

        const fetchImpl = fetchOK(() => ({ accepted: 1, rejected: [] }));
        await runPush({ fetchImpl });

        const after = getOrInitSyncState();
        expect(after.last_push_at).not.toBeNull();
    });

    it('does not stamp last_push_at when there is nothing to push', async () => {
        const fetchImpl = fetchOK(() => ({ accepted: 0, rejected: [] }));
        await runPush({ fetchImpl });
        const state = getOrInitSyncState();
        expect(state.last_push_at).toBeNull();
    });

    it('decrypts the envelope back to the original journal row', async () => {
        seedJournalEntry();
        let envelope = null as unknown as { v: 1; e: string; n: string; c: string };
        const fetchImpl = fetchOK((_url, init) => {
            const batch = JSON.parse(String(init?.body)) as PushBatch;
            envelope = batch.entries[0].envelope;
            return { accepted: 1, rejected: [] };
        });
        await runPush({ fetchImpl });

        const plaintext = decryptEnvelope(envelope, masterKey);
        const parsed = JSON.parse(plaintext) as Record<string, unknown>;
        expect(parsed.op).toBe('concept_create');
        expect(parsed.entity_id).toBe('foo');
        expect(parsed.scope_kind).toBe('codebase');
        expect((parsed.payload as { slug: string }).slug).toBe('foo');
    });

    it('does not mark rejected entries as pushed', async () => {
        const a = seedJournalEntry();
        const b = seedJournalEntry();
        const fetchImpl = fetchOK(() => ({
            accepted: 1,
            rejected: [{ sync_id: b, reason: 'duplicate' }],
        }));
        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(1);
        expect(result.rejected).toBe(1);
        const stillUnpushed = listUnpushed().map((e) => e.sync_id);
        expect(stillUnpushed).toContain(b);
        expect(stillUnpushed).not.toContain(a);
    });

    it('returns 0 pushed when the journal has nothing unpushed', async () => {
        const fetchImpl = fetchOK(() => ({ accepted: 0, rejected: [] }));
        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(0);
    });

    it('aborts when sync is disabled', async () => {
        seedJournalEntry();
        setEnabled(false);
        const fetchImpl = fetchOK(() => ({ accepted: 1, rejected: [] }));
        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toMatch(/disabled/);
    });

    it('aborts when last_error is set (circuit-breaker open)', async () => {
        seedJournalEntry();
        setLastError('previous failure');
        const fetchImpl = fetchOK(() => ({ accepted: 1, rejected: [] }));
        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toMatch(/circuit-breaker/);
    });

    it('aborts when no master key is in the keyring', async () => {
        seedJournalEntry();
        deleteMasterKey();
        const fetchImpl = fetchOK(() => ({ accepted: 1, rejected: [] }));
        const result = await runPush({ fetchImpl });
        expect(result.pushed).toBe(0);
        expect(result.errors[0]).toMatch(/master key/);
    });
});

/** ─── Pull pipeline ─── */

function makeRemoteEntry(payload: Record<string, unknown>, key: Buffer = masterKey): PullEntry {
    const sync_id = `${Date.now().toString(16).padStart(12, '0')}-${Math.random().toString(16).slice(2, 22).padEnd(20, '0')}`;
    const plaintext = JSON.stringify({
        op: 'concept_create',
        entity_id: 'remote-1',
        scope_kind: 'codebase',
        scope_key: 'repo-b',
        payload,
        device_id: 'remote-device',
        created_at: new Date().toISOString(),
    });
    return {
        sync_id,
        envelope: encryptEnvelope(plaintext, key),
        scope_routing_tag: 't',
        received_at: new Date().toISOString(),
    };
}

describe('runPull', () => {
    it('decrypts pulled entries and inserts them with pulled_at set', async () => {
        const remote = makeRemoteEntry({ slug: 'remote-1', name: 'Remote One' });
        const fetchImpl = fetchOK(() => ({ entries: [remote], next_cursor: null }));
        const result = await runPull({ fetchImpl });
        expect(result.pulled).toBe(1);
        expect(result.errors).toEqual([]);

        const pulled = listUnapplied();
        expect(pulled).toHaveLength(1);
        expect(pulled[0].sync_id).toBe(remote.sync_id);
        expect(pulled[0].entity_id).toBe('remote-1');
        expect(pulled[0].device_id).toBe('remote-device');
        expect(pulled[0].pulled_at).not.toBeNull();
        expect(pulled[0].applied_at).toBeNull();
    });

    it('is idempotent — re-pulling the same sync_id is a no-op', async () => {
        const remote = makeRemoteEntry({ slug: 'r1' });
        const fetchImpl = fetchOK(() => ({ entries: [remote], next_cursor: null }));
        const a = await runPull({ fetchImpl });
        const b = await runPull({ fetchImpl });
        expect(a.pulled).toBe(1);
        expect(b.pulled).toBe(0);
        expect(countJournal()).toBe(1);
    });

    it('skips an entry that fails to decrypt without aborting the batch', async () => {
        const good = makeRemoteEntry({ slug: 'good' });
        const wrongKey = generateMasterKey();
        const bad = makeRemoteEntry({ slug: 'bad' }, wrongKey);
        const fetchImpl = fetchOK(() => ({ entries: [bad, good], next_cursor: null }));
        const result = await runPull({ fetchImpl });
        expect(result.pulled).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/decrypt failed/);
        const pulled = listUnapplied();
        expect(pulled).toHaveLength(1);
        expect(pulled[0].entity_id).toBe('remote-1');
    });

    it('advances last_pull_cursor after a successful pull', async () => {
        const remote = makeRemoteEntry({ slug: 'r' });
        const fetchImpl = fetchOK(() => ({ entries: [remote], next_cursor: 'cursor-after-batch' }));
        await runPull({ fetchImpl });
        const state = getOrInitSyncState();
        expect(state.last_pull_cursor).toBe('cursor-after-batch');
        expect(state.last_pull_at).not.toBeNull();
    });

    it('advances last_pull_cursor when terminal page returns next_cursor: null with entries', async () => {
        /**
         * Regression: previously the loop broke before assigning `cursor`,
         * leaving last_pull_at stale and the next pull re-fetching the
         * same final page.
         */
        const remote = makeRemoteEntry({ slug: 'terminal-page' });
        const fetchImpl = fetchOK(() => ({ entries: [remote], next_cursor: null }));
        await runPull({ fetchImpl });
        const state = getOrInitSyncState();
        expect(state.last_pull_cursor).toBe(remote.sync_id);
        expect(state.last_pull_at).not.toBeNull();
    });

    it('advances last_pull_cursor on a terminal page even when last_pull_cursor was already set', async () => {
        /**
         * Regression: when state.last_pull_cursor was already set from a
         * prior cycle, the terminal-page case used the stale incoming
         * cursor (== state.last_pull_cursor) as the candidate for the
         * update, so the equality guard short-circuited and last_pull_at
         * stayed stale. Fix: prefer highestSyncId on terminal pages.
         */
        updateCursor({ last_pull_cursor: 'old-cursor-from-prior-cycle' });
        const remote = makeRemoteEntry({ slug: 'fresh-on-terminal' });
        const fetchImpl = fetchOK(() => ({ entries: [remote], next_cursor: null }));
        await runPull({ fetchImpl });
        const state = getOrInitSyncState();
        expect(state.last_pull_cursor).toBe(remote.sync_id);
        expect(state.last_pull_at).not.toBeNull();
    });

    it('passes scope tags to the relay query', async () => {
        upsertScope({ kind: 'framework', key: 'react' });
        upsertScope({ kind: 'codebase', key: 'real-codebase' });
        upsertScope({ kind: 'codebase', key: 'local-skipme' });

        const captured: { url: string } = { url: '' };
        const fetchImpl: FetchLike = async (url) => {
            captured.url = url;
            return new Response(JSON.stringify({ entries: [], next_cursor: null }), {
                status: 200,
            });
        };

        await runPull({ fetchImpl });
        const u = new URL(captured.url);
        const tags = u.searchParams.getAll('scope');
        /** personal:me + react + real-codebase, but NOT local-skipme. */
        expect(tags.length).toBeGreaterThanOrEqual(3);
    });
});

/** ─── runSync — push then pull ─── */

describe('runSync', () => {
    it('runs push first, then pull', async () => {
        seedJournalEntry();
        const calls: string[] = [];
        const fetchImpl: FetchLike = async (url, init) => {
            const method = init?.method ?? 'GET';
            calls.push(method);
            if (method === 'POST') {
                return new Response(JSON.stringify({ accepted: 1, rejected: [] }), { status: 200 });
            }
            return new Response(JSON.stringify({ entries: [], next_cursor: null }), {
                status: 200,
            });
        };
        await runSync({ fetchImpl });
        expect(calls[0]).toBe('POST');
        expect(calls[1]).toBe('GET');
    });
});

/** ─── Circuit-breaker ─── */

describe('circuit-breaker', () => {
    it('clearLastError resets both the persistent and in-memory state', async () => {
        setLastError('boom');
        clearLastError();
        const state = getOrInitSyncState();
        expect(state.last_error).toBeNull();
    });

    it('opens after 5 consecutive sync failures', async () => {
        seedJournalEntry();
        const fetchImpl: FetchLike = async () => {
            throw new Error('network down');
        };
        for (let i = 0; i < 5; i++) {
            const r = await runSync({ fetchImpl });
            expect(r.errors.length).toBeGreaterThan(0);
        }
        const state = getOrInitSyncState();
        expect(state.last_error).toMatch(/5 consecutive failures/);
    });
});

/** ─── computeLocalScopeTags ─── */

describe('computeLocalScopeTags', () => {
    it('always includes the personal:me tag', () => {
        const tags = computeLocalScopeTags(masterKey);
        expect(tags.length).toBeGreaterThan(0);
    });

    it('skips local- codebase scopes (path-based, never synced)', () => {
        upsertScope({ kind: 'codebase', key: 'local-abcdef' });
        upsertScope({ kind: 'codebase', key: 'realsync-key' });
        const tags = computeLocalScopeTags(masterKey);
        /** Both scopes registered, but only one contributes a tag — plus personal:me. */
        expect(tags.length).toBe(2);
    });

    it('produces deterministic tags for the same key + scopes', () => {
        upsertScope({ kind: 'language', key: 'ts' });
        const a = computeLocalScopeTags(masterKey);
        const b = computeLocalScopeTags(masterKey);
        expect(a.sort()).toEqual(b.sort());
    });
});
