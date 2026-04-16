import { getDb } from '../store/database.js';

/**
 * In-process batch depth. When non-zero, `invalidateProfile()` records
 * that an invalidation is pending and defers the SQL write. The deferred
 * write fires exactly once when the outermost batch exits, coalescing
 * hundreds of store-layer invalidations (one per upsertConcept etc.)
 * into a single UPDATE.
 *
 * Per-process — multi-process writers still round-trip through the DB
 * `valid` column, so cross-process correctness is unchanged.
 */
let batchDepth = 0;
let pendingInvalidation = false;

/**
 * Invalidate the profile cache.
 * Call this after any operation that changes the knowledge base state:
 * - source add/delete
 * - compilation complete
 * - concept/edge upsert
 *
 * When called inside `withBatchedInvalidation(...)` this records a
 * pending invalidation without touching the DB; the single coalesced
 * UPDATE fires on batch exit.
 */
export function invalidateProfile(): void {
    if (batchDepth > 0) {
        pendingInvalidation = true;
        return;
    }
    runInvalidateSql();
}

/**
 * Coalesce every `invalidateProfile()` call made inside `fn` into a single
 * SQL UPDATE fired when the outermost batch exits. Nested calls are safe:
 * the coalesce only triggers at `depth === 0`.
 *
 * Works for both sync and async fns — detected by promise instanceof so
 * thenables from userland behave correctly.
 */
export function withBatchedInvalidation<T>(fn: () => T): T;
export function withBatchedInvalidation<T>(fn: () => Promise<T>): Promise<T>;
export function withBatchedInvalidation<T>(fn: () => T | Promise<T>): T | Promise<T> {
    batchDepth++;
    let result: T | Promise<T>;
    try {
        result = fn();
    } catch (err) {
        batchDepth--;
        flushIfOutermost();
        throw err;
    }

    if (result instanceof Promise) {
        return result.then(
            (value) => {
                batchDepth--;
                flushIfOutermost();
                return value;
            },
            (err) => {
                batchDepth--;
                flushIfOutermost();
                throw err;
            },
        );
    }

    batchDepth--;
    flushIfOutermost();
    return result;
}

function flushIfOutermost(): void {
    if (batchDepth !== 0) return;
    if (!pendingInvalidation) return;
    pendingInvalidation = false;
    runInvalidateSql();
}

function runInvalidateSql(): void {
    try {
        getDb().prepare('UPDATE profile_snapshot SET valid = 0 WHERE id = 1').run();
    } catch {
        /** Table may not exist yet during init — safe to ignore. */
    }
}
