import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    appendJournal,
    listUnpushed,
    listUnapplied,
    markPushed,
    markApplied,
    countJournal,
    countUnpushed,
    getOrInitSyncState,
    setEnabled,
    setRelayConfig,
    updateCursor,
    setLastError,
} from '../src/sync/index.js';
import { upsertConcept, retireConcept, updateCompiledTruth } from '../src/store/concepts.js';
import { recordFeedback } from '../src/store/feedback.js';
import { captureTrajectory } from '../src/trajectory/index.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-sync-journal-'));
    process.env.LUMEN_DIR = tempDir;
    resetDataDir();
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    delete process.env.LUMEN_DIR;
    rmSync(tempDir, { recursive: true, force: true });
});

function seedConcept(slug: string, opts: { truth?: string; scope_key?: string } = {}): void {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name: slug,
        summary: opts.truth ?? null,
        compiled_truth: opts.truth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
        scope_kind: 'codebase',
        scope_key: opts.scope_key ?? 'repo-a',
    });
}

/** ─── Schema v15 ─── */

describe('schema v15', () => {
    it('reports user_version >= 15', () => {
        const v = getDb().pragma('user_version', { simple: true }) as number;
        expect(v).toBeGreaterThanOrEqual(15);
    });

    it('creates sync_state and sync_journal tables with the expected columns', () => {
        const stateCols = (getDb().pragma('table_info(sync_state)') as Array<{ name: string }>).map(
            (c) => c.name,
        );
        expect(stateCols).toContain('device_id');
        expect(stateCols).toContain('user_hash');
        expect(stateCols).toContain('enabled');

        const journalCols = (
            getDb().pragma('table_info(sync_journal)') as Array<{ name: string }>
        ).map((c) => c.name);
        for (const expected of [
            'sync_id',
            'op',
            'entity_id',
            'scope_kind',
            'scope_key',
            'payload',
            'device_id',
            'created_at',
            'pushed_at',
            'pulled_at',
            'applied_at',
        ]) {
            expect(journalCols).toContain(expected);
        }
    });

    it('rejects an invalid op via the CHECK constraint', () => {
        getOrInitSyncState();
        expect(() =>
            getDb()
                .prepare(
                    `INSERT INTO sync_journal (sync_id, op, entity_id, scope_kind, scope_key, payload, device_id, created_at)
                     VALUES ('s1', 'bogus', 'e', 'codebase', 'k', '{}', 'd', '2026-01-01')`,
                )
                .run(),
        ).toThrow(/CHECK constraint failed/);
    });

    it('enforces sync_state singleton via CHECK id = 1', () => {
        getOrInitSyncState();
        expect(() =>
            getDb().prepare('INSERT INTO sync_state (id, device_id) VALUES (2, ?)').run('dev2'),
        ).toThrow(/CHECK constraint failed/);
    });
});

/** ─── sync_state singleton ─── */

describe('getOrInitSyncState', () => {
    it('lazy-creates the row on first call', () => {
        const state = getOrInitSyncState();
        expect(state.device_id).toMatch(/^[a-f0-9]{16}$/);
        expect(state.enabled).toBe(0);
        expect(state.user_hash).toBeNull();
    });

    it('is idempotent — repeated calls return the same device_id', () => {
        const a = getOrInitSyncState();
        const b = getOrInitSyncState();
        expect(a.device_id).toBe(b.device_id);
    });

    it('setEnabled flips the flag', () => {
        getOrInitSyncState();
        setEnabled(true);
        expect(getOrInitSyncState().enabled).toBe(1);
        setEnabled(false);
        expect(getOrInitSyncState().enabled).toBe(0);
    });

    it('setRelayConfig populates user_hash + relay_url + fingerprint', () => {
        setRelayConfig({
            user_hash: 'abcd1234567890ef',
            relay_url: 'https://relay.example.com',
            encryption_key_fingerprint: 'fp1234',
        });
        const state = getOrInitSyncState();
        expect(state.user_hash).toBe('abcd1234567890ef');
        expect(state.relay_url).toBe('https://relay.example.com');
        expect(state.encryption_key_fingerprint).toBe('fp1234');
    });

    it('updateCursor + setLastError work', () => {
        updateCursor({ last_push_cursor: 'cursor-1', last_pull_cursor: 'cursor-2' });
        setLastError('ratelimit hit');
        const state = getOrInitSyncState();
        expect(state.last_push_cursor).toBe('cursor-1');
        expect(state.last_pull_cursor).toBe('cursor-2');
        expect(state.last_error).toBe('ratelimit hit');
        expect(state.last_push_at).not.toBeNull();
        expect(state.last_pull_at).not.toBeNull();
    });
});

/** ─── appendJournal + list/mark CRUD ─── */

describe('journal CRUD', () => {
    it('appendJournal returns a sortable sync_id with the right shape', () => {
        const id = appendJournal({
            op: 'concept_create',
            entity_id: 'foo',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
            payload: { slug: 'foo', name: 'Foo' },
        });
        /** 12 hex (unix ms) + dash + 4 hex (counter) + 16 hex (random) = 32 hex after the dash. */
        expect(id).toMatch(/^[a-f0-9]{12}-[a-f0-9]{20}$/);
    });

    it('produces sortable sync_ids across calls', async () => {
        const a = appendJournal({
            op: 'concept_create',
            entity_id: 'a',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
            payload: {},
        });
        await new Promise((r) => setTimeout(r, 5));
        const b = appendJournal({
            op: 'concept_create',
            entity_id: 'b',
            scope_kind: 'codebase',
            scope_key: 'repo-a',
            payload: {},
        });
        expect(a < b).toBe(true);
    });

    it('listUnpushed returns rows oldest-first; markPushed clears them from the list', () => {
        const a = appendJournal({
            op: 'concept_create',
            entity_id: 'a',
            scope_kind: 'codebase',
            scope_key: 'r',
            payload: {},
        });
        const b = appendJournal({
            op: 'concept_create',
            entity_id: 'b',
            scope_kind: 'codebase',
            scope_key: 'r',
            payload: {},
        });
        expect(listUnpushed().map((e) => e.sync_id)).toEqual([a, b]);
        markPushed([a]);
        expect(listUnpushed().map((e) => e.sync_id)).toEqual([b]);
    });

    it('listUnapplied filters to pulled but not yet applied entries', () => {
        const a = appendJournal({
            op: 'feedback',
            entity_id: 'c',
            scope_kind: 'codebase',
            scope_key: 'r',
            payload: {},
        });
        /** Locally-originated entry; pulled_at stays null - should NOT appear. */
        expect(listUnapplied()).toHaveLength(0);

        /** Simulate a remote pull by stamping pulled_at directly. */
        getDb()
            .prepare('UPDATE sync_journal SET pulled_at = ? WHERE sync_id = ?')
            .run('2026-01-01', a);
        expect(listUnapplied()).toHaveLength(1);

        markApplied([a]);
        expect(listUnapplied()).toHaveLength(0);
    });

    it('countJournal + countUnpushed reflect state after mutations', () => {
        appendJournal({
            op: 'concept_create',
            entity_id: 'a',
            scope_kind: 'codebase',
            scope_key: 'r',
            payload: {},
        });
        const id = appendJournal({
            op: 'concept_create',
            entity_id: 'b',
            scope_kind: 'codebase',
            scope_key: 'r',
            payload: {},
        });
        expect(countJournal()).toBe(2);
        expect(countUnpushed()).toBe(2);
        markPushed([id]);
        expect(countUnpushed()).toBe(1);
    });
});

/** ─── Write-path triggers ─── */

describe('write-path triggers append journal entries', () => {
    it('upsertConcept journals concept_create on a fresh slug', () => {
        seedConcept('attention', { truth: 'self-attention mechanism in transformers' });
        const entries = listUnpushed();
        const created = entries.find((e) => e.op === 'concept_create');
        expect(created).toBeDefined();
        expect(created?.entity_id).toBe('attention');
        expect((created?.payload as { name: string }).name).toBe('attention');
    });

    it('upsertConcept does NOT journal on an update (ON CONFLICT path)', () => {
        seedConcept('a');
        const after_first = countJournal();
        seedConcept('a');
        /** Re-upsert of same slug bumps mention_count but should not add a journal row. */
        expect(countJournal()).toBe(after_first);
    });

    it('recordFeedback journals feedback', () => {
        seedConcept('foo');
        const before = countJournal();
        recordFeedback({ slug: 'foo', delta: 1 });
        const entries = listUnpushed();
        const fb = entries.find((e) => e.op === 'feedback');
        expect(countJournal()).toBe(before + 1);
        expect(fb).toBeDefined();
        expect((fb?.payload as { delta: number }).delta).toBe(1);
    });

    it('updateCompiledTruth journals truth_update', () => {
        seedConcept('foo', { truth: 'old' });
        const before = countJournal();
        updateCompiledTruth('foo', 'new synthesis');
        expect(countJournal()).toBe(before + 1);
        const entries = listUnpushed();
        const tu = entries.find((e) => e.op === 'truth_update');
        expect(tu).toBeDefined();
        expect((tu?.payload as { new_truth: string }).new_truth).toBe('new synthesis');
    });

    it('retireConcept journals retire only on first call (idempotent)', () => {
        seedConcept('foo');
        const before = countJournal();
        retireConcept('foo', 'cleanup');
        expect(countJournal()).toBe(before + 1);
        retireConcept('foo', 'redundant');
        /** Second call is a no-op against an already-retired concept. */
        expect(countJournal()).toBe(before + 1);
    });

    it('captureTrajectory journals trajectory', () => {
        const before = countJournal();
        const result = captureTrajectory({
            task: 'add a route',
            outcome: 'success',
            steps: [
                { tool: 'read', args: {}, result_summary: 'ok', result_ok: true, elapsed_ms: 5 },
                {
                    tool: 'edit',
                    args: {},
                    result_summary: 'patched',
                    result_ok: true,
                    elapsed_ms: 5,
                },
            ],
            cwd: tempDir,
        });
        expect(countJournal()).toBe(before + 1);
        const entry = listUnpushed().find((e) => e.op === 'trajectory');
        expect(entry).toBeDefined();
        expect(entry?.entity_id).toBe(result.source_id);
    });

    it('every journal entry carries a stable device_id from sync_state', () => {
        seedConcept('a');
        seedConcept('b');
        seedConcept('c');
        const entries = listUnpushed();
        const deviceIds = new Set(entries.map((e) => e.device_id));
        expect(deviceIds.size).toBe(1);
    });
});
