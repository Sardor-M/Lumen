import { getDb } from '../store/database.js';
import { buildProfile } from './builder.js';
import type { LumenProfile } from './builder.js';

type SnapshotRow = {
    data: string;
    generated_at: string;
    valid: number;
};

/** Read the cached profile. Returns null if cache is missing or invalidated. */
export function getCachedProfile(): LumenProfile | null {
    const row = getDb()
        .prepare('SELECT data, generated_at, valid FROM profile_snapshot WHERE id = 1')
        .get() as SnapshotRow | undefined;

    if (!row || row.valid === 0) return null;

    try {
        return JSON.parse(row.data) as LumenProfile;
    } catch {
        return null;
    }
}

/** Write a fresh profile to the cache. */
export function saveProfileCache(profile: LumenProfile): void {
    getDb()
        .prepare(
            `INSERT INTO profile_snapshot (id, data, generated_at, valid)
             VALUES (1, @data, @generated_at, 1)
             ON CONFLICT(id) DO UPDATE SET
               data = @data,
               generated_at = @generated_at,
               valid = 1`,
        )
        .run({
            data: JSON.stringify(profile),
            generated_at: profile.generated_at,
        });
}

/** Mark the cache as stale. Next read will return null and trigger a rebuild. */
export function invalidateProfileCache(): void {
    getDb().prepare('UPDATE profile_snapshot SET valid = 0 WHERE id = 1').run();
}

/**
 * Get profile with caching. Returns cached if valid, rebuilds otherwise.
 * This is the primary entry point for all profile reads.
 */
export function getProfile(forceRefresh = false): LumenProfile {
    if (!forceRefresh) {
        const cached = getCachedProfile();
        if (cached) return cached;
    }

    const profile = buildProfile();
    saveProfileCache(profile);
    return profile;
}
