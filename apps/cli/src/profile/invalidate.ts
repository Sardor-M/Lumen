import { getDb } from '../store/database.js';

/**
 * Invalidate the profile cache.
 * Call this after any operation that changes the knowledge base state:
 * - source add/delete
 * - compilation complete
 * - concept/edge upsert
 */
export function invalidateProfile(): void {
    try {
        getDb().prepare('UPDATE profile_snapshot SET valid = 0 WHERE id = 1').run();
    } catch {
        /** Table may not exist yet during init — safe to ignore. */
    }
}
