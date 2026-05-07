/**
 * Tier 5 end-to-end — exercises the full sync loop across two simulated
 * `LUMEN_DIR` instances connected by an in-memory mock relay. Touches every
 * sub-tier:
 *
 *   5a — sync_journal write-path triggers (upsertConcept, recordFeedback,
 *        updateCompiledTruth, retireConcept all append journal rows)
 *   5b — encrypt/decrypt envelope round-trip
 *   5c — relay client push/pull + cursor pagination
 *   5d — exercised indirectly via the mock relay's ?since semantics
 *   5e — apply pass translating pulled rows into local store mutations
 *
 * Verifies that mutations on device A become observable on device B after
 * a single push → pull → apply cycle, with no plaintext touching the relay.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    setMasterKey,
    deleteMasterKey,
    setKeyringBackend,
    setEnabled,
    setRelayConfig,
    runPush,
    runPull,
    runApply,
    resetCircuitBreakerForTests,
    generateMasterKey,
    deriveUserHash,
    fingerprintMasterKey,
    decryptEnvelope,
    type FetchLike,
    type PushBatch,
    type PullEntry,
    type EncryptionEnvelope,
} from '../src/sync/index.js';
import {
    upsertConcept,
    getConcept,
    updateCompiledTruth,
    retireConcept,
} from '../src/store/concepts.js';
import { recordFeedback } from '../src/store/feedback.js';

let dirA: string;
let dirB: string;
let masterKey: Buffer;

/** Yield long enough that consecutive ISO timestamps differ — otherwise
 *  same-ms writes tie on `updated_at` and the LWW path returns `tie`. */
function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'lumen-e2e-A-'));
    dirB = mkdtempSync(join(tmpdir(), 'lumen-e2e-B-'));
    masterKey = generateMasterKey();
    process.env.LUMEN_RELAY_NO_BACKOFF = '1';
});

afterEach(() => {
    deleteMasterKey();
    setKeyringBackend(null);
    resetDb();
    resetDataDir();
    delete process.env.LUMEN_DIR;
    delete process.env.LUMEN_RELAY_NO_BACKOFF;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
});

/**
 * Switch the test process between the two simulated devices. Each switch
 * tears down the prepared-statement cache and the singleton DB handle so
 * the next `getDb()` opens against the new LUMEN_DIR. The master key is
 * shared (simulating a successful Tier 6 key-share onboarding).
 */
function useDevice(dir: string): void {
    resetDb();
    resetDataDir();
    process.env.LUMEN_DIR = dir;
    setKeyringBackend('memory');
    setMasterKey(masterKey);
    getDb();
    setRelayConfig({
        user_hash: deriveUserHash(masterKey),
        relay_url: 'https://relay.test',
        encryption_key_fingerprint: fingerprintMasterKey(masterKey),
    });
    setEnabled(true);
    resetCircuitBreakerForTests();
}

/** In-memory relay shared across both devices. Closes over `entries`. */
function makeMockRelay(): { fetch: FetchLike; entries: PullEntry[] } {
    const entries: PullEntry[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
            const batch = JSON.parse(String(init?.body)) as PushBatch;
            for (const e of batch.entries) {
                entries.push({
                    sync_id: e.sync_id,
                    envelope: e.envelope,
                    scope_routing_tag: e.scope_routing_tag,
                    received_at: new Date().toISOString(),
                });
            }
            return new Response(JSON.stringify({ accepted: batch.entries.length, rejected: [] }), {
                status: 200,
            });
        }
        /** GET — honour the `since` query so cursor pagination behaves like Tier 5d. */
        const u = new URL(url);
        const since = u.searchParams.get('since') ?? '';
        const filtered = since ? entries.filter((e) => e.sync_id > since) : [...entries];
        return new Response(JSON.stringify({ entries: filtered, next_cursor: null }), {
            status: 200,
        });
    };
    return { fetch: fetchImpl, entries };
}

describe('Tier 5 end-to-end (A → relay → B)', () => {
    it('round-trips concept_create + feedback + truth_update from A to B', async () => {
        const relay = makeMockRelay();

        /** ─── Device A: mutate locally, push to relay ─── */
        useDevice(dirA);
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'attention',
            name: 'Attention',
            summary: 'self-attention mechanism',
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'personal',
            scope_key: 'me',
        });
        await tick();
        recordFeedback({ slug: 'attention', delta: 1, reason: 'cited in 3 papers' });
        await tick();
        updateCompiledTruth('attention', 'Self-attention scales O(n^2) in sequence length.');

        const pushResult = await runPush({ fetchImpl: relay.fetch });
        expect(pushResult.errors).toEqual([]);
        expect(pushResult.pushed).toBe(3);
        expect(relay.entries).toHaveLength(3);

        /** All envelopes on the wire must be opaque to anyone without Kx. */
        for (const e of relay.entries) {
            expect(e.envelope.v).toBe(1);
            expect(e.envelope.c.length).toBeGreaterThan(0);
            /** Plaintext is JSON; reject the trivial "looks like JSON" leak check. */
            const raw = Buffer.from(e.envelope.c, 'base64').toString('utf-8');
            expect(raw.startsWith('{')).toBe(false);
        }

        /** Spot-check: round-trip one envelope with the master key reproduces the original op. */
        const decoded = JSON.parse(decryptEnvelope(relay.entries[0].envelope, masterKey)) as {
            op: string;
            entity_id: string;
        };
        expect(decoded.op).toBe('concept_create');
        expect(decoded.entity_id).toBe('attention');

        /** ─── Device B: pull, apply, verify state matches ─── */
        useDevice(dirB);
        expect(getConcept('attention')).toBeNull();

        const pullResult = await runPull({ fetchImpl: relay.fetch });
        expect(pullResult.errors).toEqual([]);
        expect(pullResult.pulled).toBe(3);

        const applyResult = runApply();
        expect(applyResult.applied).toBe(3);
        expect(applyResult.apply_failed).toBe(0);

        const conceptOnB = getConcept('attention');
        expect(conceptOnB).not.toBeNull();
        expect(conceptOnB?.name).toBe('Attention');
        expect(conceptOnB?.compiled_truth).toBe('Self-attention scales O(n^2) in sequence length.');
        expect(conceptOnB?.score).toBe(1);
    });

    it('round-trips a retire from A to B (retired_at observable on B)', async () => {
        const relay = makeMockRelay();

        useDevice(dirA);
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'deprecated-pattern',
            name: 'Deprecated Pattern',
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'personal',
            scope_key: 'me',
        });
        retireConcept('deprecated-pattern', 'superseded by new pattern');

        const pushResult = await runPush({ fetchImpl: relay.fetch });
        expect(pushResult.pushed).toBe(2);

        useDevice(dirB);
        await runPull({ fetchImpl: relay.fetch });
        const applyResult = runApply();
        expect(applyResult.applied).toBe(2);

        const conceptOnB = getConcept('deprecated-pattern');
        expect(conceptOnB).not.toBeNull();
        expect(conceptOnB?.retired_at).not.toBeNull();
        expect(conceptOnB?.retire_reason).toBe('superseded by new pattern');
    });

    it('relay sees only opaque ciphertext — wrong key cannot decrypt', async () => {
        const relay = makeMockRelay();
        useDevice(dirA);
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'private',
            name: 'Private',
            summary: 'sensitive content',
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'personal',
            scope_key: 'me',
        });
        await runPush({ fetchImpl: relay.fetch });
        expect(relay.entries.length).toBeGreaterThan(0);

        const wrongKey = generateMasterKey();
        expect(() => decryptEnvelope(relay.entries[0].envelope, wrongKey)).toThrow();
    });

    it('pull is idempotent — re-running a sync cycle does not duplicate state on B', async () => {
        const relay = makeMockRelay();

        useDevice(dirA);
        const now = new Date().toISOString();
        upsertConcept({
            slug: 'dedup-test',
            name: 'Dedup',
            summary: null,
            compiled_truth: null,
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
            scope_kind: 'personal',
            scope_key: 'me',
        });
        recordFeedback({ slug: 'dedup-test', delta: 1, reason: 'first' });
        await runPush({ fetchImpl: relay.fetch });

        useDevice(dirB);
        await runPull({ fetchImpl: relay.fetch });
        runApply();
        expect(getConcept('dedup-test')?.score).toBe(1);

        /** Re-pull (no new entries on the relay). insertPulled is idempotent
         *  on sync_id, applyPending is idempotent on applied_at IS NOT NULL. */
        const secondPull = await runPull({ fetchImpl: relay.fetch });
        expect(secondPull.pulled).toBe(0);
        const secondApply = runApply();
        expect(secondApply.applied).toBe(0);
        expect(getConcept('dedup-test')?.score).toBe(1);
    });
});
