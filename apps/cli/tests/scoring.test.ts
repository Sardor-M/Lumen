import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, resetDb } from '../src/store/database.js';
import {
    upsertConcept,
    getConcept,
    getActiveConcept,
    retireConcept,
    unretireConcept,
    updateScore,
} from '../src/store/concepts.js';
import {
    recordFeedback,
    feedbackTotal,
    listFeedback,
    countFeedback,
} from '../src/store/feedback.js';
import { RETIRE_THRESHOLD } from '../src/types/index.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumen-scoring-'));
    setDataDir(tempDir);
    getDb();
});

afterEach(() => {
    resetDb();
    resetDataDir();
    rmSync(tempDir, { recursive: true, force: true });
});

function seedConcept(slug: string, name = slug): void {
    const now = new Date().toISOString();
    upsertConcept({
        slug,
        name,
        summary: null,
        compiled_truth: null,
        article: null,
        created_at: now,
        updated_at: now,
        mention_count: 1,
    });
}

/* ─── Migration v11 ─── */

describe('schema v11', () => {
    it('reports user_version >= 11 after fresh init', () => {
        /** Tier 3b bumped to 12; the v11 columns/tables under test still apply. */
        const v = getDb().pragma('user_version', { simple: true }) as number;
        expect(v).toBeGreaterThanOrEqual(11);
    });

    it('adds score / retired_at / retire_reason to concepts', () => {
        const cols = getDb().pragma('table_info(concepts)') as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
        }>;
        const score = cols.find((c) => c.name === 'score');
        const retiredAt = cols.find((c) => c.name === 'retired_at');
        const retireReason = cols.find((c) => c.name === 'retire_reason');
        expect(score).toBeDefined();
        expect(score?.type).toBe('INTEGER');
        expect(score?.notnull).toBe(1);
        expect(score?.dflt_value).toBe('0');
        expect(retiredAt).toBeDefined();
        expect(retiredAt?.notnull).toBe(0);
        expect(retireReason).toBeDefined();
    });

    it('creates concept_feedback table with delta CHECK constraint', () => {
        const cols = getDb().pragma('table_info(concept_feedback)') as Array<{ name: string }>;
        expect(cols.map((c) => c.name).sort()).toEqual(
            [
                'concept_slug',
                'created_at',
                'delta',
                'device_id',
                'id',
                'reason',
                'session_id',
            ].sort(),
        );

        seedConcept('check-target');
        expect(() =>
            getDb()
                .prepare(
                    `INSERT INTO concept_feedback (concept_slug, delta, reason, session_id, device_id, created_at)
                     VALUES ('check-target', 0, null, null, null, '2026-01-01')`,
                )
                .run(),
        ).toThrow(/CHECK constraint failed/);

        expect(() =>
            getDb()
                .prepare(
                    `INSERT INTO concept_feedback (concept_slug, delta, reason, session_id, device_id, created_at)
                     VALUES ('check-target', 2, null, null, null, '2026-01-01')`,
                )
                .run(),
        ).toThrow(/CHECK constraint failed/);
    });

    it('creates score and retired indexes', () => {
        const idx = getDb()
            .prepare(
                `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='concepts' AND name LIKE 'idx_concepts_%'`,
            )
            .all() as Array<{ name: string }>;
        const names = idx.map((r) => r.name);
        expect(names).toContain('idx_concepts_score');
        expect(names).toContain('idx_concepts_retired');
    });
});

/* ─── Concept default scoring fields ─── */

describe('concept defaults', () => {
    it('new concept has score = 0 and is not retired', () => {
        seedConcept('attention');
        const c = getConcept('attention');
        expect(c?.score).toBe(0);
        expect(c?.retired_at).toBeNull();
        expect(c?.retire_reason).toBeNull();
    });

    it('upsertConcept preserves existing score on update (does not reset to 0)', () => {
        seedConcept('attention');
        recordFeedback({ slug: 'attention', delta: 1 });
        recordFeedback({ slug: 'attention', delta: 1 });
        expect(getConcept('attention')?.score).toBe(2);

        const now = new Date().toISOString();
        upsertConcept({
            slug: 'attention',
            name: 'Attention v2',
            summary: 'updated',
            compiled_truth: 'updated',
            article: null,
            created_at: now,
            updated_at: now,
            mention_count: 1,
        });

        const c = getConcept('attention');
        expect(c?.name).toBe('Attention v2');
        expect(c?.score).toBe(2);
    });
});

/* ─── recordFeedback / feedbackTotal / listFeedback ─── */

describe('recordFeedback', () => {
    it('inserts a +1 row and updates score to +1', () => {
        seedConcept('skill-a');
        const result = recordFeedback({ slug: 'skill-a', delta: 1 });
        expect(result.new_score).toBe(1);
        expect(result.retired).toBe(false);
        expect(getConcept('skill-a')?.score).toBe(1);
    });

    it('inserts a -1 row and updates score to -1', () => {
        seedConcept('skill-b');
        const result = recordFeedback({ slug: 'skill-b', delta: -1, reason: 'wrong' });
        expect(result.new_score).toBe(-1);
        expect(result.retired).toBe(false);
    });

    it('computes score as the SUM of deltas', () => {
        seedConcept('skill-c');
        recordFeedback({ slug: 'skill-c', delta: 1 });
        recordFeedback({ slug: 'skill-c', delta: 1 });
        recordFeedback({ slug: 'skill-c', delta: -1 });
        recordFeedback({ slug: 'skill-c', delta: 1 });
        expect(feedbackTotal('skill-c')).toBe(2);
        expect(getConcept('skill-c')?.score).toBe(2);
    });

    it('persists session_id and device_id when provided', () => {
        seedConcept('skill-d');
        recordFeedback({
            slug: 'skill-d',
            delta: 1,
            session_id: 'sess-1',
            device_id: 'dev-1',
        });
        const rows = listFeedback('skill-d');
        expect(rows[0].session_id).toBe('sess-1');
        expect(rows[0].device_id).toBe('dev-1');
    });

    it('returns the inserted row id', () => {
        seedConcept('skill-e');
        const a = recordFeedback({ slug: 'skill-e', delta: 1 });
        const b = recordFeedback({ slug: 'skill-e', delta: 1 });
        expect(b.feedback_id).toBeGreaterThan(a.feedback_id);
    });
});

describe('listFeedback', () => {
    it('returns rows newest-first', async () => {
        seedConcept('hist');
        recordFeedback({ slug: 'hist', delta: 1, reason: 'first' });
        await new Promise((r) => setTimeout(r, 10));
        recordFeedback({ slug: 'hist', delta: -1, reason: 'second' });
        await new Promise((r) => setTimeout(r, 10));
        recordFeedback({ slug: 'hist', delta: 1, reason: 'third' });
        const rows = listFeedback('hist');
        expect(rows.map((r) => r.reason)).toEqual(['third', 'second', 'first']);
    });

    it('honors the limit', () => {
        seedConcept('lim');
        for (let i = 0; i < 5; i++) {
            recordFeedback({ slug: 'lim', delta: 1, reason: `r${i}` });
        }
        expect(listFeedback('lim', 2).length).toBe(2);
    });
});

describe('countFeedback', () => {
    it('totals feedback rows across all concepts', () => {
        seedConcept('a');
        seedConcept('b');
        recordFeedback({ slug: 'a', delta: 1 });
        recordFeedback({ slug: 'b', delta: 1 });
        recordFeedback({ slug: 'b', delta: -1 });
        expect(countFeedback()).toBe(3);
    });
});

/* ─── Auto-retire at threshold ─── */

describe('auto-retire on threshold', () => {
    it('retires when cumulative score crosses RETIRE_THRESHOLD (-3)', () => {
        seedConcept('bad');
        recordFeedback({ slug: 'bad', delta: -1, reason: 'r1' });
        recordFeedback({ slug: 'bad', delta: -1, reason: 'r2' });
        let c = getConcept('bad');
        expect(c?.retired_at).toBeNull();
        expect(c?.score).toBe(-2);

        const result = recordFeedback({ slug: 'bad', delta: -1, reason: 'final straw' });
        expect(result.retired).toBe(true);
        expect(result.new_score).toBe(RETIRE_THRESHOLD);

        c = getConcept('bad');
        expect(c?.retired_at).not.toBeNull();
        expect(c?.retire_reason).toBe('final straw');
    });

    it('does not re-stamp retired_at on subsequent negative votes', async () => {
        seedConcept('bad2');
        recordFeedback({ slug: 'bad2', delta: -1, reason: 'a' });
        recordFeedback({ slug: 'bad2', delta: -1, reason: 'b' });
        recordFeedback({ slug: 'bad2', delta: -1, reason: 'first retire' });
        const firstRetire = getConcept('bad2')?.retired_at;
        await new Promise((r) => setTimeout(r, 15));
        const result = recordFeedback({ slug: 'bad2', delta: -1, reason: 'extra' });
        expect(result.retired).toBe(false);
        expect(getConcept('bad2')?.retired_at).toBe(firstRetire);
        expect(getConcept('bad2')?.retire_reason).toBe('first retire');
    });

    it('does not auto-retire when score is just above threshold (-2)', () => {
        seedConcept('borderline');
        recordFeedback({ slug: 'borderline', delta: -1 });
        recordFeedback({ slug: 'borderline', delta: -1 });
        const result = recordFeedback({ slug: 'borderline', delta: 1 });
        expect(result.new_score).toBe(-1);
        expect(getConcept('borderline')?.retired_at).toBeNull();
    });

    it('uses a generic reason when the most recent negative has no reason', () => {
        seedConcept('reasonless');
        recordFeedback({ slug: 'reasonless', delta: -1 });
        recordFeedback({ slug: 'reasonless', delta: -1 });
        recordFeedback({ slug: 'reasonless', delta: -1 });
        const c = getConcept('reasonless');
        expect(c?.retired_at).not.toBeNull();
        expect(c?.retire_reason).toMatch(/auto-retired/i);
    });
});

/* ─── retireConcept / unretireConcept ─── */

describe('explicit retireConcept', () => {
    it('sets retired_at and retire_reason', () => {
        seedConcept('m');
        retireConcept('m', 'manual cleanup');
        const c = getConcept('m');
        expect(c?.retired_at).not.toBeNull();
        expect(c?.retire_reason).toBe('manual cleanup');
    });

    it('is idempotent — second call keeps original timestamp and reason', async () => {
        seedConcept('idem');
        retireConcept('idem', 'first');
        const first = getConcept('idem');
        await new Promise((r) => setTimeout(r, 15));
        retireConcept('idem', 'second');
        const second = getConcept('idem');
        expect(second?.retired_at).toBe(first?.retired_at);
        expect(second?.retire_reason).toBe('first');
    });
});

describe('unretireConcept', () => {
    it('clears retired_at and retire_reason', () => {
        seedConcept('z');
        retireConcept('z', 'oops');
        expect(getConcept('z')?.retired_at).not.toBeNull();
        unretireConcept('z');
        const c = getConcept('z');
        expect(c?.retired_at).toBeNull();
        expect(c?.retire_reason).toBeNull();
    });
});

/* ─── getActiveConcept ─── */

describe('getActiveConcept', () => {
    it('returns the concept when active', () => {
        seedConcept('alive');
        expect(getActiveConcept('alive')?.slug).toBe('alive');
    });

    it('returns null when retired', () => {
        seedConcept('dead');
        retireConcept('dead', 'gone');
        expect(getActiveConcept('dead')).toBeNull();
        /** Plain getConcept still returns it. */
        expect(getConcept('dead')?.slug).toBe('dead');
    });

    it('returns null for a missing slug', () => {
        expect(getActiveConcept('nonexistent-slug')).toBeNull();
    });
});

/* ─── updateScore direct ─── */

describe('updateScore', () => {
    it('writes the new score and does not touch retirement when above threshold', () => {
        seedConcept('s');
        updateScore('s', 5);
        expect(getConcept('s')?.score).toBe(5);
        expect(getConcept('s')?.retired_at).toBeNull();
    });

    it('auto-retires when the score crosses the threshold', () => {
        seedConcept('s2');
        updateScore('s2', -5, 'manual override');
        const c = getConcept('s2');
        expect(c?.retired_at).not.toBeNull();
        expect(c?.retire_reason).toBe('manual override');
    });

    it('is a no-op for an unknown slug', () => {
        expect(() => updateScore('does-not-exist', 10)).not.toThrow();
    });
});

/* ─── Cascade delete ─── */

describe('feedback cascade on concept delete', () => {
    it('removes feedback rows when the parent concept is deleted', () => {
        seedConcept('to-delete');
        recordFeedback({ slug: 'to-delete', delta: 1 });
        recordFeedback({ slug: 'to-delete', delta: -1 });
        expect(listFeedback('to-delete').length).toBe(2);

        getDb().prepare('DELETE FROM concepts WHERE slug = ?').run('to-delete');
        expect(listFeedback('to-delete').length).toBe(0);
    });
});
