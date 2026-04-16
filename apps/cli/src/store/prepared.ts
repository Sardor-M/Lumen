import type Database from 'better-sqlite3';

/**
 * Per-database prepared-statement cache.
 *
 * better-sqlite3's `db.prepare(sql)` is non-trivial — it parses SQL, builds
 * an internal VDBE program, and registers cleanup handlers. For statements
 * used in hot loops (e.g. the chunk + source lookup in search result
 * resolution), caching the prepared statement cuts per-call overhead to
 * a single `.get()` / `.all()`.
 *
 * Keyed by the `Database` instance via `WeakMap` so `closeDb()` lets GC
 * reclaim the map — reopening the DB gets a fresh cache automatically.
 * Inside that, keyed by the SQL string so callers can share statements
 * without coordinating naming.
 */
const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/**
 * Return a cached `Database.Statement` for the given SQL, preparing it on
 * first use. Caller is responsible for making the SQL identical on repeat
 * calls — any whitespace difference counts as a new statement.
 */
export function getStmt(db: Database.Database, sql: string): Database.Statement {
    let perDb = cache.get(db);
    if (!perDb) {
        perDb = new Map();
        cache.set(db, perDb);
    }
    let stmt = perDb.get(sql);
    if (!stmt) {
        stmt = db.prepare(sql);
        perDb.set(sql, stmt);
    }
    return stmt;
}

/**
 * Drop the cache for a specific database — called from `closeDb()` so
 * the next `getDb()` on the same path never sees stale statements.
 * A no-op if nothing was cached.
 */
export function clearStmtCache(db: Database.Database): void {
    cache.delete(db);
}
