import Database from 'better-sqlite3';
import { getDbPath } from '../utils/paths.js';
import { createSchema } from './schema.js';
import { runMigrations } from './migrations.js';
import { clearStmtCache } from './prepared.js';

let db: Database.Database | null = null;

/** True when sqlite-vec was successfully loaded into the current process. */
let vecAvailable = false;

export function isVecAvailable(): boolean {
    return vecAvailable;
}

/**
 * Attempt to load the sqlite-vec extension into the database.
 * Non-fatal — if the native binary is missing or unsupported, vector search
 * is silently disabled.
 */
function loadSqliteVec(instance: Database.Database): void {
    try {
        /** Dynamic import so the CLI still boots when sqlite-vec is absent. */
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
        sqliteVec.load(instance);
        vecAvailable = true;
    } catch {
        vecAvailable = false;
    }
}

export function getDb(): Database.Database {
    if (db) return db;
    db = openDatabase(getDbPath());
    return db;
}

export function openDatabase(path: string): Database.Database {
    const instance = new Database(path);

    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('foreign_keys = ON');
    instance.pragma('cache_size = -64000'); // 64MB
    instance.pragma('busy_timeout = 5000');

    /** Load sqlite-vec BEFORE schema/migrations — vec0 tables require the extension. */
    loadSqliteVec(instance);

    const version = instance.pragma('user_version', { simple: true }) as number;
    if (version === 0) {
        createSchema(instance, vecAvailable);
    } else {
        runMigrations(instance, version, vecAvailable);
    }

    return instance;
}

export function closeDb(): void {
    if (db) {
        /** Drop the prepared-statement cache BEFORE closing — otherwise the
         *  cached statements point at a finalised sqlite handle and a later
         *  reopen on the same path could theoretically reuse a stale entry. */
        clearStmtCache(db);
        db.close();
        db = null;
    }
}

export function resetDb(): void {
    db = null;
}
