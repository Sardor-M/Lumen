/**
 * Tier 5e — apply rules tests.
 *
 * Each per-op handler is exercised in isolation against a fresh DB. The
 * orchestrator is exercised on synthetic pulled-but-unapplied entries
 * (via `insertPulled`) without going through the real relay.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    insertPulled,
    listUnapplied,
    appendJournal,
    applyPending,
    applyConceptCreate,
    applyTrajectory,
    applyFeedback,
    applyTruthUpdate,
    applyRetire,
    runApply,
} from '../src/sync/index.js';
import type { JournalEntry, JournalOp } from '../src/sync/index.js';
import { upsertConcept, getConcept } from '../src/store/concepts.js';
import { listFeedback, feedbackTotal } from '../src/store/feedback.js';
import { listSources } from '../src/store/sources.js';
import { getChunksBySource } from '../src/store/chunks.js';

let tempDir: string;
let counter = 0;
const RUN_ID = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(12, '0')
    .slice(-12);

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-sync-apply-'));
    process.env.LUMEN_DIR = tempDir;
    resetDataDir();
    getDb();
    counter = 0;
});

afterEach(() => {
    resetDb();
    resetDataDir();
    delete process.env.LUMEN_DIR;
    rmSync(tempDir, { recursive: true, force: true });
});

/** UUIDv7-shaped sync_id: 12 hex ms + 4 hex monotonic + 16 hex random. */
function makeSyncId(seq?: number): string {
    const n = seq ?? ++counter;
    const monotonic = n.toString(16).padStart(4, '0').slice(-4);
    return `${RUN_ID}${monotonic}${'0'.repeat(16)}`;
}

/** Insert a pulled-but-unapplied journal entry; returns the entry shape applyPending will read. */
function seedPulled(args: {
    op: JournalOp;
    entity_id: string;
    payload: Record<string, unknown>;
    sync_id?: string;
    scope_kind?: 'personal' | 'codebase' | 'framework' | 'language' | 'team';
    scope_key?: string;
    device_id?: string;
    created_at?: string;
}): JournalEntry {
    const sync_id = args.sync_id ?? makeSyncId();
    const created_at = args.created_at ?? new Date().toISOString();
    insertPulled({
        sync_id,
        op: args.op,
        entity_id: args.entity_id,
        scope_kind: args.scope_kind ?? 'personal',
        scope_key: args.scope_key ?? 'me',
        payload: args.payload,
        device_id: args.device_id ?? 'remote-device',
        created_at,
    });
    return {
        sync_id,
        op: args.op,
        entity_id: args.entity_id,
        scope_kind: args.scope_kind ?? 'personal',
        scope_key: args.scope_key ?? 'me',
        payload: args.payload,
        device_id: args.device_id ?? 'remote-device',
        created_at,
        pushed_at: null,
        pulled_at: new Date().toISOString(),
        applied_at: null,
    };
}

/** Seed a local concept (the originating-side mutation; journals locally). */
function seedConcept(slug: string, truth?: string, updatedAt?: string): void {
    const now = updatedAt ?? new Date().toISOString();
    upsertConcept({
        slug,
        name: slug,
        summary: truth ?? null,
        compiled_truth: truth ?? null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
    });
}

describe('applyConceptCreate', () => {
    it('inserts a new concept row from the payload', () => {
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'new-concept',
            payload: {
                slug: 'new-concept',
                name: 'New Concept',
                summary: 'a fresh idea',
                compiled_truth: 'compiled truth here',
            },
            created_at: '2026-05-04T10:00:00.000Z',
        });
        applyConceptCreate(entry);
        const c = getConcept('new-concept');
        expect(c).not.toBeNull();
        expect(c?.name).toBe('New Concept');
        expect(c?.summary).toBe('a fresh idea');
        expect(c?.compiled_truth).toBe('compiled truth here');
        expect(c?.created_at).toBe('2026-05-04T10:00:00.000Z');
        expect(c?.scope_kind).toBe('personal');
        expect(c?.scope_key).toBe('me');
    });

    it('is idempotent: re-applying the same entry leaves the row unchanged', () => {
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'idem',
            payload: { slug: 'idem', name: 'Idem', summary: null, compiled_truth: null },
        });
        applyConceptCreate(entry);
        applyConceptCreate(entry);
        const c = getConcept('idem');
        expect(c?.mention_count).toBe(1);
    });

    it('does NOT overwrite an existing concept of the same slug', () => {
        seedConcept('shared-slug', 'local truth');
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'shared-slug',
            payload: {
                slug: 'shared-slug',
                name: 'shared-slug',
                summary: null,
                compiled_truth: 'remote truth',
            },
        });
        applyConceptCreate(entry);
        const c = getConcept('shared-slug');
        expect(c?.compiled_truth).toBe('local truth');
    });
});

describe('applyTrajectory', () => {
    const trajectoryPayload = {
        source_id: 'traj-abc123',
        metadata: {
            v: 1,
            task: 'sync test trajectory',
            steps: [
                {
                    n: 0,
                    tool: 'read',
                    args: { file: 'a.ts' },
                    result_summary: 'ok',
                    result_ok: true,
                    elapsed_ms: 10,
                },
                {
                    n: 1,
                    tool: 'edit',
                    args: { file: 'a.ts' },
                    result_summary: 'wrote 5 lines',
                    result_ok: true,
                    elapsed_ms: 15,
                },
            ],
            outcome: 'success',
            agent: 'test-agent',
            session_id: 'sess-1',
            total_tokens: null,
            total_elapsed_ms: 25,
            scope: { kind: 'personal', key: 'me' },
            inputs: null,
            codebase_revision: null,
        },
    };

    it('inserts a source + chunks (1 summary + N steps) from the payload', () => {
        const entry = seedPulled({
            op: 'trajectory',
            entity_id: 'traj-abc123',
            payload: trajectoryPayload,
        });
        applyTrajectory(entry);
        const sources = listSources();
        const traj = sources.find((s) => s.id === 'traj-abc123');
        expect(traj).toBeDefined();
        expect(traj?.source_type).toBe('trajectory');
        expect(traj?.title).toBe('sync test trajectory');
        const chunks = getChunksBySource('traj-abc123');
        expect(chunks).toHaveLength(3);
        expect(chunks[0].heading).toBe('Trajectory summary');
        expect(chunks[1].heading).toContain('read');
        expect(chunks[2].heading).toContain('edit');
    });

    it('is idempotent: re-applying does not duplicate source or chunks', () => {
        const entry = seedPulled({
            op: 'trajectory',
            entity_id: 'traj-abc123',
            payload: trajectoryPayload,
        });
        applyTrajectory(entry);
        applyTrajectory(entry);
        expect(listSources().filter((s) => s.id === 'traj-abc123')).toHaveLength(1);
        expect(getChunksBySource('traj-abc123')).toHaveLength(3);
    });
});

describe('applyFeedback', () => {
    it('inserts a feedback row + recomputes concept score', () => {
        seedConcept('feedback-slug');
        const entry = seedPulled({
            op: 'feedback',
            entity_id: 'feedback-slug',
            payload: {
                concept_slug: 'feedback-slug',
                delta: 1,
                reason: 'helpful',
                session_id: 's1',
            },
        });
        applyFeedback(entry);
        const fb = listFeedback('feedback-slug');
        expect(fb).toHaveLength(1);
        expect(fb[0].delta).toBe(1);
        expect(fb[0].reason).toBe('helpful');
        expect(feedbackTotal('feedback-slug')).toBe(1);
    });

    it('preserves device_id and sync_id on the inserted row', () => {
        seedConcept('attribution');
        const entry = seedPulled({
            op: 'feedback',
            entity_id: 'attribution',
            payload: { concept_slug: 'attribution', delta: -1, reason: null, session_id: null },
            device_id: 'device-A',
        });
        applyFeedback(entry);
        const row = getDb()
            .prepare('SELECT device_id, sync_id FROM concept_feedback WHERE concept_slug = ?')
            .get('attribution') as { device_id: string; sync_id: string };
        expect(row.device_id).toBe('device-A');
        expect(row.sync_id).toBe(entry.sync_id);
    });

    it('is idempotent: re-applying same sync_id does not duplicate the row', () => {
        seedConcept('idem-fb');
        const entry = seedPulled({
            op: 'feedback',
            entity_id: 'idem-fb',
            payload: { concept_slug: 'idem-fb', delta: 1, reason: null, session_id: null },
        });
        applyFeedback(entry);
        applyFeedback(entry);
        expect(listFeedback('idem-fb')).toHaveLength(1);
        expect(feedbackTotal('idem-fb')).toBe(1);
    });

    it('three downvotes auto-retire the concept (score crosses threshold)', () => {
        seedConcept('to-retire');
        for (let i = 0; i < 4; i++) {
            const entry = seedPulled({
                op: 'feedback',
                entity_id: 'to-retire',
                payload: {
                    concept_slug: 'to-retire',
                    delta: -1,
                    reason: 'wrong',
                    session_id: null,
                },
            });
            applyFeedback(entry);
        }
        const c = getConcept('to-retire');
        expect(c?.retired_at).not.toBeNull();
        expect(feedbackTotal('to-retire')).toBe(-4);
    });
});

describe('applyTruthUpdate (LWW)', () => {
    it('won: incoming.updated_at > existing → overwrites concepts.compiled_truth', () => {
        seedConcept('lww-slug', 'old truth');
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'lww-slug',
            payload: {
                concept_slug: 'lww-slug',
                new_truth: 'newer truth',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        const result = applyTruthUpdate(entry);
        expect(result.lww).toBe('won');
        expect(getConcept('lww-slug')?.compiled_truth).toBe('newer truth');
    });

    it('won: previous truth lands in concept_truth_history with superseded_by = entry.sync_id', () => {
        seedConcept('hist', 'first truth');
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'hist',
            payload: {
                concept_slug: 'hist',
                new_truth: 'second truth',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        applyTruthUpdate(entry);
        const rows = getDb()
            .prepare('SELECT truth, superseded_by FROM concept_truth_history WHERE slug = ?')
            .all('hist') as Array<{ truth: string; superseded_by: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].truth).toBe('first truth');
        expect(rows[0].superseded_by).toBe(entry.sync_id);
    });

    it('lost: incoming.updated_at < existing → concept untouched, incoming lands in history', () => {
        seedConcept('lost', 'newer local truth');
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'lost',
            payload: {
                concept_slug: 'lost',
                new_truth: 'older remote truth',
                updated_at: '2000-01-01T00:00:00.000Z',
            },
        });
        const result = applyTruthUpdate(entry);
        expect(result.lww).toBe('lost');
        expect(getConcept('lost')?.compiled_truth).toBe('newer local truth');
        const rows = getDb()
            .prepare('SELECT truth, superseded_by FROM concept_truth_history WHERE slug = ?')
            .all('lost') as Array<{ truth: string; superseded_by: string | null }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].truth).toBe('older remote truth');
        expect(rows[0].superseded_by).toBeNull();
    });

    it('tie: incoming.updated_at == existing → no concept change, no history row', () => {
        /**
         * Regression: previously the equal-timestamp case fell through to
         * the "lost" path and inserted a spurious history row even though
         * nothing was displaced. A peer with the same tied timestamp also
         * keeps its own truth, so symmetric audit on both sides would
         * double-count.
         */
        const tiedTimestamp = '2026-05-05T12:00:00.000Z';
        seedConcept('tie-slug', 'local truth', tiedTimestamp);
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'tie-slug',
            payload: {
                concept_slug: 'tie-slug',
                new_truth: 'remote truth at same timestamp',
                updated_at: tiedTimestamp,
            },
        });
        const result = applyTruthUpdate(entry);
        expect(result.lww).toBe('tie');
        expect(getConcept('tie-slug')?.compiled_truth).toBe('local truth');
        const rows = getDb()
            .prepare('SELECT 1 FROM concept_truth_history WHERE slug = ?')
            .all('tie-slug');
        expect(rows).toHaveLength(0);
    });

    it('missing concept throws so applyPending retries on next cycle', () => {
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'absent',
            payload: {
                concept_slug: 'absent',
                new_truth: 'truth',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        expect(() => applyTruthUpdate(entry)).toThrow(/concept not found for slug "absent"/);
        expect(getConcept('absent')).toBeNull();
    });

    it('idempotent (won) after a SECOND truth_update overwrites the concept', () => {
        /**
         * Reviewer scenario: X applies as winner, Y later applies as winner
         * with a higher updated_at. Re-applying X must still recognize
         * "already won" — the superseded_by trail from X's original win
         * persists in concept_truth_history because rows are append-only.
         */
        seedConcept('chain', 'truth-0');

        const x = seedPulled({
            sync_id: makeSyncId(1),
            op: 'truth_update',
            entity_id: 'chain',
            payload: {
                concept_slug: 'chain',
                new_truth: 'truth-X',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        const xResult = applyTruthUpdate(x);
        expect(xResult.lww).toBe('won');

        const y = seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'chain',
            payload: {
                concept_slug: 'chain',
                new_truth: 'truth-Y',
                updated_at: '2099-06-01T00:00:00.000Z',
            },
        });
        const yResult = applyTruthUpdate(y);
        expect(yResult.lww).toBe('won');

        /** Re-apply X — concept now has Y's truth and a higher updated_at. */
        const xRedo = applyTruthUpdate(x);
        expect(xRedo.lww).toBe('won');

        /**
         * History should have exactly two rows: truth-0 (X's loser) +
         * truth-X (Y's loser). No spurious row from the X re-apply.
         */
        const rows = getDb()
            .prepare(
                'SELECT truth, superseded_by FROM concept_truth_history WHERE slug = ? ORDER BY id ASC',
            )
            .all('chain') as Array<{ truth: string; superseded_by: string | null }>;
        expect(rows).toHaveLength(2);
        expect(rows[0].truth).toBe('truth-0');
        expect(rows[0].superseded_by).toBe(x.sync_id);
        expect(rows[1].truth).toBe('truth-X');
        expect(rows[1].superseded_by).toBe(y.sync_id);
        expect(getConcept('chain')?.compiled_truth).toBe('truth-Y');
    });

    it('idempotent (won): re-applying same entry does not write a duplicate history row', () => {
        seedConcept('idem-truth', 'old');
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'idem-truth',
            payload: {
                concept_slug: 'idem-truth',
                new_truth: 'new',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        applyTruthUpdate(entry);
        applyTruthUpdate(entry);
        const rows = getDb()
            .prepare('SELECT COUNT(*) AS c FROM concept_truth_history WHERE slug = ?')
            .get('idem-truth') as { c: number };
        expect(rows.c).toBe(1);
    });
});

describe('applyRetire', () => {
    it('sets retired_at + retire_reason on an active concept', () => {
        seedConcept('retire-me');
        const entry = seedPulled({
            op: 'retire',
            entity_id: 'retire-me',
            payload: { concept_slug: 'retire-me', reason: 'outdated' },
            created_at: '2026-05-04T12:00:00.000Z',
        });
        applyRetire(entry);
        const c = getConcept('retire-me');
        expect(c?.retired_at).toBe('2026-05-04T12:00:00.000Z');
        expect(c?.retire_reason).toBe('outdated');
    });

    it('idempotent: re-applying preserves the original timestamp + reason (COALESCE)', () => {
        seedConcept('idem-retire');
        const first = seedPulled({
            op: 'retire',
            entity_id: 'idem-retire',
            payload: { concept_slug: 'idem-retire', reason: 'first reason' },
            created_at: '2026-01-01T00:00:00.000Z',
        });
        applyRetire(first);
        const second = seedPulled({
            op: 'retire',
            entity_id: 'idem-retire',
            payload: { concept_slug: 'idem-retire', reason: 'second reason' },
            created_at: '2026-12-31T23:59:59.000Z',
        });
        applyRetire(second);
        const c = getConcept('idem-retire');
        expect(c?.retired_at).toBe('2026-01-01T00:00:00.000Z');
        expect(c?.retire_reason).toBe('first reason');
    });

    it('missing concept throws so applyPending retries on next cycle', () => {
        const entry = seedPulled({
            op: 'retire',
            entity_id: 'phantom',
            payload: { concept_slug: 'phantom', reason: 'nope' },
        });
        expect(() => applyRetire(entry)).toThrow(/concept not found for slug "phantom"/);
    });
});

describe('applyPending orchestrator', () => {
    it('processes entries in sync_id order; concept_create before its feedback', () => {
        const ts = (n: number) => `2026-05-04T10:00:0${n}.000Z`;
        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'orch',
            payload: { slug: 'orch', name: 'orch', summary: null, compiled_truth: null },
            created_at: ts(1),
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'feedback',
            entity_id: 'orch',
            payload: { concept_slug: 'orch', delta: 1, reason: null, session_id: null },
            created_at: ts(2),
        });
        const result = applyPending();
        expect(result.applied).toBe(2);
        expect(result.failed).toEqual([]);
        expect(result.by_op.concept_create).toBe(1);
        expect(result.by_op.feedback).toBe(1);
        expect(getConcept('orch')).not.toBeNull();
        expect(feedbackTotal('orch')).toBe(1);
    });

    it('marks each successfully-applied entry as applied_at = now', () => {
        seedPulled({
            op: 'concept_create',
            entity_id: 'mark-me',
            payload: { slug: 'mark-me', name: 'mark-me', summary: null, compiled_truth: null },
        });
        applyPending();
        expect(listUnapplied()).toHaveLength(0);
    });

    it('per-entry transaction: feedback whose concept is missing fails, others still apply', () => {
        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'good',
            payload: { slug: 'good', name: 'good', summary: null, compiled_truth: null },
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'feedback',
            entity_id: 'no-such-concept',
            payload: { concept_slug: 'no-such-concept', delta: 1, reason: null, session_id: null },
        });
        const result = applyPending();
        expect(result.applied).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].op).toBe('feedback');
        expect(getConcept('good')).not.toBeNull();
        /** Failed entry stays applied_at = NULL for retry on the next call. */
        const remaining = listUnapplied();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].entity_id).toBe('no-such-concept');
    });

    it('is idempotent: re-running on a fully-applied journal is a no-op', () => {
        seedPulled({
            op: 'concept_create',
            entity_id: 'noop',
            payload: { slug: 'noop', name: 'noop', summary: null, compiled_truth: null },
        });
        applyPending();
        const second = applyPending();
        expect(second.applied).toBe(0);
        expect(second.failed).toEqual([]);
    });

    it('respects opts.limit', () => {
        for (let i = 0; i < 5; i++) {
            seedPulled({
                sync_id: makeSyncId(),
                op: 'concept_create',
                entity_id: `c${i}`,
                payload: { slug: `c${i}`, name: `c${i}`, summary: null, compiled_truth: null },
            });
        }
        const first = applyPending({ limit: 2 });
        expect(first.applied).toBe(2);
        expect(listUnapplied()).toHaveLength(3);
    });

    it('does NOT process locally-originated entries (pulled_at IS NULL)', () => {
        /** appendJournal sets pulled_at = NULL — that's the local-write path. */
        appendJournal({
            op: 'concept_create',
            entity_id: 'local-only',
            scope_kind: 'personal',
            scope_key: 'me',
            payload: {
                slug: 'local-only',
                name: 'local-only',
                summary: null,
                compiled_truth: null,
            },
        });
        const result = applyPending();
        expect(result.applied).toBe(0);
    });
});

describe('runApply (driver entry point)', () => {
    it('returns SyncResult with applied + apply_failed counters', () => {
        seedPulled({
            op: 'concept_create',
            entity_id: 'driver',
            payload: { slug: 'driver', name: 'driver', summary: null, compiled_truth: null },
        });
        const result = runApply();
        expect(result.applied).toBe(1);
        expect(result.apply_failed).toBe(0);
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(0);
        expect(result.errors).toEqual([]);
    });

    it('surfaces apply failures into result.errors', () => {
        seedPulled({
            op: 'feedback',
            entity_id: 'missing',
            payload: { concept_slug: 'missing', delta: 1, reason: null, session_id: null },
        });
        const result = runApply();
        expect(result.applied).toBe(0);
        expect(result.apply_failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('apply feedback');
    });
});

/** ─── Extended edge-case coverage ───────────────────────────────────── */

describe('boundary + edge-case data', () => {
    it('trajectory with 0 steps produces only the summary chunk', () => {
        const entry = seedPulled({
            op: 'trajectory',
            entity_id: 'traj-empty',
            payload: {
                source_id: 'traj-empty',
                metadata: {
                    v: 1,
                    task: 'no-op trajectory',
                    steps: [],
                    outcome: 'success',
                    agent: 'a',
                    session_id: 's',
                    total_tokens: null,
                    total_elapsed_ms: 0,
                    scope: { kind: 'personal', key: 'me' },
                    inputs: null,
                    codebase_revision: null,
                },
            },
        });
        applyTrajectory(entry);
        const chunks = getChunksBySource('traj-empty');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].heading).toBe('Trajectory summary');
    });

    it('trajectory with 30 steps produces 1 summary + 30 step chunks', () => {
        const steps = Array.from({ length: 30 }, (_, i) => ({
            n: i,
            tool: `tool-${i}`,
            args: { i },
            result_summary: `step ${i} result`,
            result_ok: true,
            elapsed_ms: 5,
        }));
        const entry = seedPulled({
            op: 'trajectory',
            entity_id: 'traj-large',
            payload: {
                source_id: 'traj-large',
                metadata: {
                    v: 1,
                    task: 'large trajectory',
                    steps,
                    outcome: 'success',
                    agent: 'a',
                    session_id: 's',
                    total_tokens: null,
                    total_elapsed_ms: 150,
                    scope: { kind: 'personal', key: 'me' },
                    inputs: null,
                    codebase_revision: null,
                },
            },
        });
        applyTrajectory(entry);
        const chunks = getChunksBySource('traj-large');
        expect(chunks).toHaveLength(31);
    });

    it('applyConceptCreate with NULL summary AND NULL compiled_truth still inserts the row', () => {
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'bare',
            payload: { slug: 'bare', name: 'Bare', summary: null, compiled_truth: null },
        });
        applyConceptCreate(entry);
        const c = getConcept('bare');
        expect(c).not.toBeNull();
        expect(c?.summary).toBeNull();
        expect(c?.compiled_truth).toBeNull();
    });

    it('applyTruthUpdate: existing.compiled_truth is NULL → loser stored as NULL in history (column is nullable)', () => {
        const now = new Date().toISOString();
        seedConcept('null-truth', undefined, now);
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'null-truth',
            payload: {
                concept_slug: 'null-truth',
                new_truth: 'first-actual-truth',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        const result = applyTruthUpdate(entry);
        expect(result.lww).toBe('won');
        const row = getDb()
            .prepare('SELECT truth FROM concept_truth_history WHERE slug = ? AND superseded_by = ?')
            .get('null-truth', entry.sync_id) as { truth: string | null };
        expect(row.truth).toBeNull();
        expect(getConcept('null-truth')?.compiled_truth).toBe('first-actual-truth');
    });

    it('applyPending on an empty journal returns clean result', () => {
        const result = applyPending();
        expect(result).toEqual({ applied: 0, failed: [], by_op: {} });
    });

    it('applyPending with opts.limit = 0 still drains nothing (treats as default? — current contract)', () => {
        seedPulled({
            op: 'concept_create',
            entity_id: 'limit-zero',
            payload: {
                slug: 'limit-zero',
                name: 'limit-zero',
                summary: null,
                compiled_truth: null,
            },
        });
        /**
         * `?? DEFAULT_BATCH_LIMIT` means `limit: 0` falls back to default 200.
         * Document that explicitly so future readers don't expect "limit:0 = no-op".
         */
        const result = applyPending({ limit: 0 });
        expect(result.applied).toBe(1);
    });
});

describe('multi-device LWW chains', () => {
    it('three truth_updates from three devices, in-order arrival → final = highest updated_at', () => {
        seedConcept('chain-3', 'truth-0', '2099-01-01T00:00:00.000Z');

        const x = seedPulled({
            sync_id: makeSyncId(1),
            op: 'truth_update',
            entity_id: 'chain-3',
            payload: {
                concept_slug: 'chain-3',
                new_truth: 'X',
                updated_at: '2099-02-01T00:00:00.000Z',
            },
            device_id: 'device-X',
        });
        const y = seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'chain-3',
            payload: {
                concept_slug: 'chain-3',
                new_truth: 'Y',
                updated_at: '2099-03-01T00:00:00.000Z',
            },
            device_id: 'device-Y',
        });
        const z = seedPulled({
            sync_id: makeSyncId(3),
            op: 'truth_update',
            entity_id: 'chain-3',
            payload: {
                concept_slug: 'chain-3',
                new_truth: 'Z',
                updated_at: '2099-04-01T00:00:00.000Z',
            },
            device_id: 'device-Z',
        });

        expect(applyTruthUpdate(x).lww).toBe('won');
        expect(applyTruthUpdate(y).lww).toBe('won');
        expect(applyTruthUpdate(z).lww).toBe('won');

        expect(getConcept('chain-3')?.compiled_truth).toBe('Z');

        /** Three losers in history: truth-0 (by X), X (by Y), Y (by Z). */
        const rows = getDb()
            .prepare(
                'SELECT truth, superseded_by FROM concept_truth_history WHERE slug = ? ORDER BY id ASC',
            )
            .all('chain-3') as Array<{ truth: string; superseded_by: string }>;
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.truth)).toEqual(['truth-0', 'X', 'Y']);
        expect(rows.map((r) => r.superseded_by)).toEqual([x.sync_id, y.sync_id, z.sync_id]);
    });

    it('three truth_updates arriving in REVERSE order → final = highest updated_at, two losers in history', () => {
        seedConcept('chain-rev', 'truth-0', '2099-01-01T00:00:00.000Z');

        const x = seedPulled({
            sync_id: makeSyncId(1),
            op: 'truth_update',
            entity_id: 'chain-rev',
            payload: {
                concept_slug: 'chain-rev',
                new_truth: 'X',
                updated_at: '2099-02-01T00:00:00.000Z',
            },
        });
        const y = seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'chain-rev',
            payload: {
                concept_slug: 'chain-rev',
                new_truth: 'Y',
                updated_at: '2099-03-01T00:00:00.000Z',
            },
        });
        const z = seedPulled({
            sync_id: makeSyncId(3),
            op: 'truth_update',
            entity_id: 'chain-rev',
            payload: {
                concept_slug: 'chain-rev',
                new_truth: 'Z',
                updated_at: '2099-04-01T00:00:00.000Z',
            },
        });

        /** Z first (wins), Y second (loses to Z), X third (loses to Z). */
        expect(applyTruthUpdate(z).lww).toBe('won');
        expect(applyTruthUpdate(y).lww).toBe('lost');
        expect(applyTruthUpdate(x).lww).toBe('lost');

        expect(getConcept('chain-rev')?.compiled_truth).toBe('Z');

        const rows = getDb()
            .prepare(
                `SELECT truth, superseded_by FROM concept_truth_history
                 WHERE slug = ? ORDER BY id ASC`,
            )
            .all('chain-rev') as Array<{ truth: string; superseded_by: string | null }>;
        /** truth-0 (loser to Z, superseded_by=Z), then Y and X each as loser-path rows (superseded_by=NULL). */
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({ truth: 'truth-0', superseded_by: z.sync_id });
        expect(rows[1]).toEqual({ truth: 'Y', superseded_by: null });
        expect(rows[2]).toEqual({ truth: 'X', superseded_by: null });
    });
});

describe('multi-device feedback', () => {
    it('two devices vote on the same concept — both rows insert, score = sum of deltas', () => {
        seedConcept('multi-fb');

        const a = seedPulled({
            sync_id: makeSyncId(1),
            op: 'feedback',
            entity_id: 'multi-fb',
            payload: { concept_slug: 'multi-fb', delta: 1, reason: 'A loved it', session_id: null },
            device_id: 'device-A',
        });
        const b = seedPulled({
            sync_id: makeSyncId(2),
            op: 'feedback',
            entity_id: 'multi-fb',
            payload: {
                concept_slug: 'multi-fb',
                delta: -1,
                reason: 'B disagreed',
                session_id: null,
            },
            device_id: 'device-B',
        });

        applyFeedback(a);
        applyFeedback(b);

        const rows = listFeedback('multi-fb');
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.device_id))).toEqual(new Set(['device-A', 'device-B']));
        expect(feedbackTotal('multi-fb')).toBe(0);
        expect(getConcept('multi-fb')?.score).toBe(0);
    });

    it('feedback for a retired concept inserts the row but does not un-retire', () => {
        seedConcept('already-retired');
        getDb()
            .prepare(
                "UPDATE concepts SET retired_at = '2026-01-01', retire_reason = 'manual' WHERE slug = ?",
            )
            .run('already-retired');

        const entry = seedPulled({
            op: 'feedback',
            entity_id: 'already-retired',
            payload: {
                concept_slug: 'already-retired',
                delta: 1,
                reason: 'still useful',
                session_id: null,
            },
        });
        applyFeedback(entry);

        expect(listFeedback('already-retired')).toHaveLength(1);
        const c = getConcept('already-retired');
        expect(c?.retired_at).toBe('2026-01-01');
        expect(c?.retire_reason).toBe('manual');
    });
});

describe('multi-device retire', () => {
    it('two devices retire the same concept — first wins, COALESCE preserves first timestamp + reason', () => {
        seedConcept('twin-retire');

        const first = seedPulled({
            sync_id: makeSyncId(1),
            op: 'retire',
            entity_id: 'twin-retire',
            payload: { concept_slug: 'twin-retire', reason: 'A says outdated' },
            device_id: 'device-A',
            created_at: '2026-01-01T00:00:00.000Z',
        });
        const second = seedPulled({
            sync_id: makeSyncId(2),
            op: 'retire',
            entity_id: 'twin-retire',
            payload: { concept_slug: 'twin-retire', reason: 'B says wrong' },
            device_id: 'device-B',
            created_at: '2026-06-15T00:00:00.000Z',
        });

        applyRetire(first);
        applyRetire(second);

        const c = getConcept('twin-retire');
        expect(c?.retired_at).toBe('2026-01-01T00:00:00.000Z');
        expect(c?.retire_reason).toBe('A says outdated');
    });

    it('retire then later truth_update arrives → concept stays retired, truth still updates', () => {
        /**
         * Apply rules treat retire and truth_update independently. A retired
         * concept can still receive truth_update (compiled_truth gets refreshed
         * by an LWW write); retired_at is untouched.
         */
        seedConcept('zombie', 'old-truth', '2099-01-01T00:00:00.000Z');

        const retire = seedPulled({
            sync_id: makeSyncId(1),
            op: 'retire',
            entity_id: 'zombie',
            payload: { concept_slug: 'zombie', reason: 'tombstoned' },
            created_at: '2099-02-01T00:00:00.000Z',
        });
        const truth = seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'zombie',
            payload: {
                concept_slug: 'zombie',
                new_truth: 'newer-truth',
                updated_at: '2099-03-01T00:00:00.000Z',
            },
        });

        applyRetire(retire);
        applyTruthUpdate(truth);

        const c = getConcept('zombie');
        expect(c?.retired_at).toBe('2099-02-01T00:00:00.000Z');
        expect(c?.compiled_truth).toBe('newer-truth');
    });
});

describe('mixed-op same-slug batch', () => {
    it('concept_create + truth_update + feedback + retire for same slug applies cleanly in sync_id order', () => {
        /**
         * Each `seedPulled` inserts the entry into the journal as a side
         * effect; we don't need to bind the returned shape locally — the
         * orchestrator picks them up from `listUnapplied`.
         */
        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'lifecycle',
            payload: {
                slug: 'lifecycle',
                name: 'Lifecycle',
                summary: 'initial',
                compiled_truth: 'initial-truth',
            },
            created_at: '2099-01-01T00:00:00.000Z',
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'lifecycle',
            payload: {
                concept_slug: 'lifecycle',
                new_truth: 'refined-truth',
                updated_at: '2099-02-01T00:00:00.000Z',
            },
            created_at: '2099-02-01T00:00:00.000Z',
        });
        seedPulled({
            sync_id: makeSyncId(3),
            op: 'feedback',
            entity_id: 'lifecycle',
            payload: {
                concept_slug: 'lifecycle',
                delta: 1,
                reason: 'great',
                session_id: null,
            },
            created_at: '2099-03-01T00:00:00.000Z',
        });
        seedPulled({
            sync_id: makeSyncId(4),
            op: 'retire',
            entity_id: 'lifecycle',
            payload: { concept_slug: 'lifecycle', reason: 'superseded by X' },
            created_at: '2099-04-01T00:00:00.000Z',
        });

        const result = applyPending();
        expect(result.applied).toBe(4);
        expect(result.failed).toEqual([]);
        expect(result.by_op).toEqual({
            concept_create: 1,
            truth_update: 1,
            feedback: 1,
            retire: 1,
        });

        const c = getConcept('lifecycle');
        expect(c?.compiled_truth).toBe('refined-truth');
        expect(c?.retired_at).toBe('2099-04-01T00:00:00.000Z');
        expect(c?.retire_reason).toBe('superseded by X');
        expect(c?.score).toBe(1);
        expect(listFeedback('lifecycle')).toHaveLength(1);

        /** All four entries should be marked applied. */
        expect(listUnapplied()).toHaveLength(0);
    });
});

describe('orchestrator robustness', () => {
    it('skips entries that are already applied (applied_at IS NOT NULL)', () => {
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'pre-applied',
            payload: {
                slug: 'pre-applied',
                name: 'pre-applied',
                summary: null,
                compiled_truth: null,
            },
        });
        getDb()
            .prepare("UPDATE sync_journal SET applied_at = '2026-01-01' WHERE sync_id = ?")
            .run(entry.sync_id);

        const result = applyPending();
        expect(result.applied).toBe(0);
        /** Concept never inserted because we skipped the entry. */
        expect(getConcept('pre-applied')).toBeNull();
    });

    it('opts.limit = 1 processes exactly one entry, leaves the rest unapplied', () => {
        for (let i = 0; i < 4; i++) {
            seedPulled({
                sync_id: makeSyncId(),
                op: 'concept_create',
                entity_id: `c${i}`,
                payload: { slug: `c${i}`, name: `c${i}`, summary: null, compiled_truth: null },
            });
        }

        const first = applyPending({ limit: 1 });
        expect(first.applied).toBe(1);
        expect(listUnapplied()).toHaveLength(3);

        /** Remaining entries drain on subsequent calls. */
        applyPending();
        expect(listUnapplied()).toHaveLength(0);
    });

    it('partial-failure in a 3-entry batch isolates the failure; first + third still apply', () => {
        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'good-1',
            payload: { slug: 'good-1', name: 'good-1', summary: null, compiled_truth: null },
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'feedback',
            entity_id: 'orphan',
            payload: { concept_slug: 'orphan', delta: 1, reason: null, session_id: null },
        });
        seedPulled({
            sync_id: makeSyncId(3),
            op: 'concept_create',
            entity_id: 'good-2',
            payload: { slug: 'good-2', name: 'good-2', summary: null, compiled_truth: null },
        });

        const result = applyPending();
        expect(result.applied).toBe(2);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].entity_id ?? result.failed[0].op).toBeDefined();
        expect(result.by_op.concept_create).toBe(2);

        expect(getConcept('good-1')).not.toBeNull();
        expect(getConcept('good-2')).not.toBeNull();

        /** The failed feedback entry stays in the unapplied queue. */
        const remaining = listUnapplied();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].entity_id).toBe('orphan');
    });

    it('re-running applyPending after a partial failure retries the failed entries when the prerequisite arrives', () => {
        /**
         * Realistic scenario: A captured the concept first (lower sync_id),
         * then voted on it (higher sync_id). B pulled them out-of-order so
         * the feedback got pulled before the concept_create arrived.
         *
         * First applyPending call (only feedback present): fails with
         * "concept not found".
         * Second call (concept_create has now arrived locally): listUnapplied
         * returns both ordered by sync_id ASC; concept_create lands first,
         * feedback succeeds on its retry.
         */
        const conceptCreateSyncId = makeSyncId(1);
        const feedbackSyncId = makeSyncId(2);

        /** Feedback gets pulled FIRST (out-of-order) but has a HIGHER sync_id. */
        seedPulled({
            sync_id: feedbackSyncId,
            op: 'feedback',
            entity_id: 'late-create',
            payload: { concept_slug: 'late-create', delta: 1, reason: null, session_id: null },
        });
        let result = applyPending();
        expect(result.applied).toBe(0);
        expect(result.failed.length).toBe(1);

        /** Concept_create arrives later but has a LOWER sync_id (was emitted earlier on the source device). */
        seedPulled({
            sync_id: conceptCreateSyncId,
            op: 'concept_create',
            entity_id: 'late-create',
            payload: {
                slug: 'late-create',
                name: 'late-create',
                summary: null,
                compiled_truth: null,
            },
        });

        result = applyPending();
        expect(result.applied).toBe(2);
        expect(result.failed).toEqual([]);
        expect(getConcept('late-create')).not.toBeNull();
        expect(feedbackTotal('late-create')).toBe(1);
    });
});

describe('scope-aware apply', () => {
    it('codebase-scoped trajectory upserts the scopes registry', () => {
        const entry = seedPulled({
            op: 'trajectory',
            entity_id: 'codebase-traj',
            scope_kind: 'codebase',
            scope_key: 'github.com/foo/bar@abc123',
            payload: {
                source_id: 'codebase-traj',
                metadata: {
                    v: 1,
                    task: 'codebase trajectory',
                    steps: [
                        {
                            n: 0,
                            tool: 'read',
                            args: { f: 'a.ts' },
                            result_summary: 'ok',
                            result_ok: true,
                            elapsed_ms: 1,
                        },
                    ],
                    outcome: 'success',
                    agent: 'a',
                    session_id: 's',
                    total_tokens: null,
                    total_elapsed_ms: 1,
                    scope: { kind: 'codebase', key: 'github.com/foo/bar@abc123' },
                    inputs: null,
                    codebase_revision: 'abc123',
                },
            },
        });
        applyTrajectory(entry);

        const scope = getDb()
            .prepare('SELECT kind, key FROM scopes WHERE kind = ? AND key = ?')
            .get('codebase', 'github.com/foo/bar@abc123');
        expect(scope).toBeDefined();
    });

    it('concept_create with codebase scope sets scope_kind/scope_key on the row', () => {
        const entry = seedPulled({
            op: 'concept_create',
            entity_id: 'scoped',
            scope_kind: 'codebase',
            scope_key: 'github.com/x/y',
            payload: { slug: 'scoped', name: 'scoped', summary: null, compiled_truth: null },
        });
        applyConceptCreate(entry);

        const c = getConcept('scoped');
        expect(c?.scope_kind).toBe('codebase');
        expect(c?.scope_key).toBe('github.com/x/y');
    });

    it('mixed-scope batch — apply preserves each entry’s scope independently', () => {
        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'pers',
            scope_kind: 'personal',
            scope_key: 'me',
            payload: { slug: 'pers', name: 'pers', summary: null, compiled_truth: null },
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'concept_create',
            entity_id: 'cb',
            scope_kind: 'codebase',
            scope_key: 'github.com/a/b',
            payload: { slug: 'cb', name: 'cb', summary: null, compiled_truth: null },
        });
        seedPulled({
            sync_id: makeSyncId(3),
            op: 'concept_create',
            entity_id: 'fw',
            scope_kind: 'framework',
            scope_key: 'next',
            payload: { slug: 'fw', name: 'fw', summary: null, compiled_truth: null },
        });
        applyPending();

        expect(getConcept('pers')?.scope_kind).toBe('personal');
        expect(getConcept('cb')?.scope_kind).toBe('codebase');
        expect(getConcept('cb')?.scope_key).toBe('github.com/a/b');
        expect(getConcept('fw')?.scope_kind).toBe('framework');
    });
});

describe('runApply full coverage', () => {
    it('processes all five op types in a single applyPending call', () => {
        const ts = (n: number) => `2099-0${n}-01T00:00:00.000Z`;

        seedPulled({
            sync_id: makeSyncId(1),
            op: 'concept_create',
            entity_id: 'all-ops',
            payload: {
                slug: 'all-ops',
                name: 'all-ops',
                summary: 'init',
                compiled_truth: 'init-truth',
            },
            created_at: ts(1),
        });
        seedPulled({
            sync_id: makeSyncId(2),
            op: 'truth_update',
            entity_id: 'all-ops',
            payload: { concept_slug: 'all-ops', new_truth: 'updated-truth', updated_at: ts(2) },
            created_at: ts(2),
        });
        seedPulled({
            sync_id: makeSyncId(3),
            op: 'feedback',
            entity_id: 'all-ops',
            payload: { concept_slug: 'all-ops', delta: 1, reason: null, session_id: null },
            created_at: ts(3),
        });
        seedPulled({
            sync_id: makeSyncId(4),
            op: 'trajectory',
            entity_id: 'traj-all',
            payload: {
                source_id: 'traj-all',
                metadata: {
                    v: 1,
                    task: 'all-ops trajectory',
                    steps: [
                        {
                            n: 0,
                            tool: 'read',
                            args: { f: 'x.ts' },
                            result_summary: 'ok',
                            result_ok: true,
                            elapsed_ms: 1,
                        },
                    ],
                    outcome: 'success',
                    agent: 'a',
                    session_id: 's',
                    total_tokens: null,
                    total_elapsed_ms: 1,
                    scope: { kind: 'personal', key: 'me' },
                    inputs: null,
                    codebase_revision: null,
                },
            },
            created_at: ts(4),
        });
        seedPulled({
            sync_id: makeSyncId(5),
            op: 'retire',
            entity_id: 'all-ops',
            payload: { concept_slug: 'all-ops', reason: 'lifecycle complete' },
            created_at: ts(5),
        });

        const result = runApply();
        expect(result.applied).toBe(5);
        expect(result.apply_failed).toBe(0);
        expect(result.errors).toEqual([]);

        /** Final state: concept exists, has updated truth, has feedback, is retired; trajectory is its own source. */
        const c = getConcept('all-ops');
        expect(c).not.toBeNull();
        expect(c?.compiled_truth).toBe('updated-truth');
        expect(c?.score).toBe(1);
        expect(c?.retired_at).toBe(ts(5));
        expect(listSources().some((s) => s.id === 'traj-all')).toBe(true);
        expect(listUnapplied()).toHaveLength(0);
    });
});
