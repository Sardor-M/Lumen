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
function seedConcept(slug: string, truth?: string): void {
    const now = new Date().toISOString();
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

    it('skipped: concept does not exist locally → no write anywhere, returns "skipped"', () => {
        const entry = seedPulled({
            op: 'truth_update',
            entity_id: 'absent',
            payload: {
                concept_slug: 'absent',
                new_truth: 'truth',
                updated_at: '2099-01-01T00:00:00.000Z',
            },
        });
        const result = applyTruthUpdate(entry);
        expect(result.lww).toBe('skipped');
        expect(getConcept('absent')).toBeNull();
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

    it('silent no-op when the concept does not exist locally', () => {
        const entry = seedPulled({
            op: 'retire',
            entity_id: 'phantom',
            payload: { concept_slug: 'phantom', reason: 'nope' },
        });
        expect(() => applyRetire(entry)).not.toThrow();
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
