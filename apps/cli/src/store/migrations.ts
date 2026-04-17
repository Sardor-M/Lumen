import type Database from 'better-sqlite3';
import { CURRENT_VERSION, SCHEMA_VEC } from './schema.js';

type Migration = (db: Database.Database, vecAvailable?: boolean) => void;

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

    /** v5 — vector embeddings: embedding columns on chunks, vec_chunks virtual table, embedding_meta. */
    5: (db, vecAvailable) => {
        db.exec(`
            ALTER TABLE chunks ADD COLUMN embedding_model TEXT;
            ALTER TABLE chunks ADD COLUMN embedded_at TEXT;

            CREATE TABLE IF NOT EXISTS embedding_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        /** vec0 virtual table requires sqlite-vec to be loaded first. */
        if (vecAvailable) db.exec(SCHEMA_VEC);
    },

    /** v6 — compiled truth + timeline on concepts. */
    6: (db) => {
        db.exec(`
            ALTER TABLE concepts ADD COLUMN compiled_truth TEXT;
            ALTER TABLE concepts ADD COLUMN timeline TEXT NOT NULL DEFAULT '[]';

            -- Backfill: seed compiled_truth from existing summary column.
            UPDATE concepts SET compiled_truth = summary WHERE summary IS NOT NULL;
        `);
    },

    /** v7 — link management: concept_links back-link store. */
    7: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS concept_links (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                from_slug  TEXT    NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
                to_slug    TEXT    NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
                link_type  TEXT    NOT NULL DEFAULT 'reference',
                context    TEXT,
                source_id  TEXT REFERENCES sources(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                UNIQUE(from_slug, to_slug, link_type)
            );

            CREATE INDEX IF NOT EXISTS idx_links_from ON concept_links(from_slug);
            CREATE INDEX IF NOT EXISTS idx_links_to   ON concept_links(to_slug);
            CREATE INDEX IF NOT EXISTS idx_links_type ON concept_links(link_type);
        `);
    },

    /** v8 — self-improving classifiers: pattern store + fallback log. */
    8: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS classifier_patterns (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                classifier_name TEXT    NOT NULL,
                pattern         TEXT    NOT NULL,
                label           TEXT    NOT NULL,
                confidence      REAL    NOT NULL DEFAULT 1.0,
                match_count     INT     NOT NULL DEFAULT 0,
                created_at      TEXT    NOT NULL,
                source          TEXT    NOT NULL DEFAULT 'llm',
                UNIQUE(classifier_name, pattern)
            );

            CREATE TABLE IF NOT EXISTS classifier_fallbacks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                classifier_name TEXT NOT NULL,
                input           TEXT NOT NULL,
                llm_label       TEXT NOT NULL,
                pattern_used    TEXT,
                created_at      TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_patterns_classifier  ON classifier_patterns(classifier_name);
            CREATE INDEX IF NOT EXISTS idx_fallbacks_classifier ON classifier_fallbacks(classifier_name);
        `);
    },
};

export function runMigrations(
    db: Database.Database,
    fromVersion: number,
    vecAvailable = false,
): void {
    if (fromVersion >= CURRENT_VERSION) return;

    db.exec('BEGIN');
    try {
        for (let v = fromVersion + 1; v <= CURRENT_VERSION; v++) {
            const migrate = migrations[v];
            if (migrate) migrate(db, vecAvailable);
        }
        db.pragma(`user_version = ${CURRENT_VERSION}`);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
