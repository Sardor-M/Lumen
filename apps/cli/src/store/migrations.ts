import type Database from 'better-sqlite3';
import { CURRENT_VERSION } from './schema.js';

type Migration = (db: Database.Database) => void;

const migrations: Record<number, Migration> = {
    2: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS query_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tool_name TEXT NOT NULL,
                query_text TEXT,
                result_count INTEGER,
                latency_ms INTEGER,
                session_id TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_query_log_tool ON query_log(tool_name);
            CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp);
        `);
    },
    3: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS profile_snapshot (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                valid INTEGER NOT NULL DEFAULT 1
            );
        `);
    },
    4: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS connectors (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                config TEXT NOT NULL DEFAULT '{}',
                state TEXT NOT NULL DEFAULT '{}',
                interval_seconds INTEGER NOT NULL DEFAULT 3600,
                last_run_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_connectors_type ON connectors(type);
            CREATE INDEX IF NOT EXISTS idx_connectors_last_run ON connectors(last_run_at);
        `);
    },
};

export function runMigrations(db: Database.Database, fromVersion: number): void {
    if (fromVersion >= CURRENT_VERSION) return;

    db.exec('BEGIN');
    try {
        for (let v = fromVersion + 1; v <= CURRENT_VERSION; v++) {
            const migrate = migrations[v];
            if (migrate) migrate(db);
        }
        db.pragma(`user_version = ${CURRENT_VERSION}`);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
