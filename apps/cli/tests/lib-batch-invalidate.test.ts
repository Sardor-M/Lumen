import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, resetDataDir } from '../src/utils/paths.js';
import { getDb, closeDb } from '../src/store/database.js';
import { invalidateProfile, withBatchedInvalidation } from '../src/profile/invalidate.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lumen-batch-'));
    setDataDir(workDir);
    getDb();
});

afterEach(() => {
    try {
        closeDb();
    } catch {
        /** Already closed. */
    }
    resetDataDir();
    rmSync(workDir, { recursive: true, force: true });
});

/** Count DB writes to `profile_snapshot` by spying on its prepare statement
 *  through a run() counter. We use the cache.saveProfileCache path to
 *  install a known row, then observe how many UPDATEs invalidation emits. */
function seedCacheRow(): void {
    getDb()
        .prepare(
            `INSERT INTO profile_snapshot (id, data, generated_at, valid)
             VALUES (1, '{}', datetime('now'), 1)
             ON CONFLICT(id) DO UPDATE SET valid = 1`,
        )
        .run();
}

function isValid(): number {
    const row = getDb().prepare('SELECT valid FROM profile_snapshot WHERE id = 1').get() as {
        valid: number;
    };
    return row.valid;
}

describe('invalidateProfile — non-batched', () => {
    it('flips the row to valid=0 on a bare call', () => {
        seedCacheRow();
        expect(isValid()).toBe(1);
        invalidateProfile();
        expect(isValid()).toBe(0);
    });
});

describe('withBatchedInvalidation — sync', () => {
    it('defers the SQL write until the outermost batch exits', () => {
        seedCacheRow();

        const runSpy = vi.spyOn(getDb(), 'prepare');
        withBatchedInvalidation(() => {
            invalidateProfile();
            invalidateProfile();
            invalidateProfile();
            /** During the batch the row should still read valid=1. */
            expect(isValid()).toBe(1);
        });
        /** After the batch the row is invalidated exactly once. */
        expect(isValid()).toBe(0);
        runSpy.mockRestore();
    });

    it('no-op when no invalidation is called inside', () => {
        seedCacheRow();
        withBatchedInvalidation(() => {
            /** Intentionally empty. */
        });
        expect(isValid()).toBe(1);
    });

    it('nested batches coalesce to one write at the outermost exit', () => {
        seedCacheRow();
        withBatchedInvalidation(() => {
            invalidateProfile();
            withBatchedInvalidation(() => {
                invalidateProfile();
                invalidateProfile();
            });
            /** Still deferred — outer batch is open. */
            expect(isValid()).toBe(1);
            invalidateProfile();
        });
        expect(isValid()).toBe(0);
    });

    it('propagates sync throws and still flushes pending invalidation', () => {
        seedCacheRow();
        expect(() =>
            withBatchedInvalidation(() => {
                invalidateProfile();
                throw new Error('boom');
            }),
        ).toThrow('boom');
        /** The flush happens even on throw so callers don't get stale cache. */
        expect(isValid()).toBe(0);
    });

    it('returns the fn value untouched', () => {
        const out = withBatchedInvalidation(() => 42);
        expect(out).toBe(42);
    });
});

describe('withBatchedInvalidation — async', () => {
    it('defers SQL writes across an async pipeline', async () => {
        seedCacheRow();
        await withBatchedInvalidation(async () => {
            invalidateProfile();
            await Promise.resolve();
            invalidateProfile();
            expect(isValid()).toBe(1);
        });
        expect(isValid()).toBe(0);
    });

    it('propagates async rejection and flushes', async () => {
        seedCacheRow();
        await expect(
            withBatchedInvalidation(async () => {
                invalidateProfile();
                throw new Error('async boom');
            }),
        ).rejects.toThrow('async boom');
        expect(isValid()).toBe(0);
    });

    it('returns the awaited value', async () => {
        const out = await withBatchedInvalidation(async () => 'done');
        expect(out).toBe('done');
    });
});
