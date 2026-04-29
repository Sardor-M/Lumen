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

    /** v9 — tiered entity enrichment: escalation tier, enrichment queue flag, last enriched timestamp. */
    9: (db) => {
        db.exec(`
            ALTER TABLE concepts ADD COLUMN enrichment_tier   INTEGER NOT NULL DEFAULT 3;
            ALTER TABLE concepts ADD COLUMN last_enriched_at  TEXT;
            ALTER TABLE concepts ADD COLUMN enrichment_queued INTEGER NOT NULL DEFAULT 0;
        `);
    },

    /** v10 — scope dimension on sources + concepts; scopes registry table. */
    10: (db) => {
        db.exec(`
            ALTER TABLE sources  ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'personal';
            ALTER TABLE sources  ADD COLUMN scope_key  TEXT NOT NULL DEFAULT 'me';
            ALTER TABLE concepts ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'personal';
            ALTER TABLE concepts ADD COLUMN scope_key  TEXT NOT NULL DEFAULT 'me';

            CREATE INDEX IF NOT EXISTS idx_sources_scope  ON sources(scope_kind, scope_key);
            CREATE INDEX IF NOT EXISTS idx_concepts_scope ON concepts(scope_kind, scope_key);

            CREATE TABLE IF NOT EXISTS scopes (
                kind         TEXT NOT NULL,
                key          TEXT NOT NULL,
                label        TEXT,
                detected_at  TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                metadata     TEXT,
                PRIMARY KEY (kind, key)
            );
        `);
    },

    /** v11 — concept scoring + retirement; concept_feedback append-only log. */
    11: (db) => {
        db.exec(`
            ALTER TABLE concepts ADD COLUMN score         INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE concepts ADD COLUMN retired_at    TEXT;
            ALTER TABLE concepts ADD COLUMN retire_reason TEXT;

            CREATE INDEX IF NOT EXISTS idx_concepts_score   ON concepts(score);
            CREATE INDEX IF NOT EXISTS idx_concepts_retired ON concepts(retired_at);

            CREATE TABLE IF NOT EXISTS concept_feedback (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                concept_slug TEXT NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
                delta        INTEGER NOT NULL CHECK (delta IN (-1, 1)),
                reason       TEXT,
                session_id   TEXT,
                device_id    TEXT,
                created_at   TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_feedback_concept ON concept_feedback(concept_slug);
        `);
    },

    /** v12 — concept_aliases table for merge-on-write near-duplicate handling. */
    12: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS concept_aliases (
                alias          TEXT PRIMARY KEY,
                canonical_slug TEXT NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
                scope_kind     TEXT NOT NULL,
                scope_key      TEXT NOT NULL,
                merged_at      TEXT NOT NULL,
                merge_reason   TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON concept_aliases(canonical_slug);
            CREATE INDEX IF NOT EXISTS idx_aliases_scope     ON concept_aliases(scope_kind, scope_key);
        `);
    },

    /** v13 — exploration-cost telemetry on query_log. */
    13: (db) => {
        db.exec(`
            ALTER TABLE query_log ADD COLUMN tokens_spent      INTEGER;
            ALTER TABLE query_log ADD COLUMN skill_hit         INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE query_log ADD COLUMN exploration_depth INTEGER;
            ALTER TABLE query_log ADD COLUMN scope_kind        TEXT;
            ALTER TABLE query_log ADD COLUMN scope_key         TEXT;

            CREATE INDEX IF NOT EXISTS idx_query_log_skill_hit ON query_log(skill_hit);
            CREATE INDEX IF NOT EXISTS idx_query_log_scope     ON query_log(scope_kind, scope_key);
        `);
    },

    /** v14 — trajectory review pass: per-session LLM extraction outcome record. */
    14: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS session_review (
                session_id    TEXT PRIMARY KEY,
                reviewed_at   TEXT NOT NULL,
                outcome       TEXT NOT NULL CHECK (outcome IN ('extracted', 'no_skill', 'failed', 'skipped')),
                trajectory_id TEXT,
                notes         TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_session_review_outcome ON session_review(outcome);
            CREATE INDEX IF NOT EXISTS idx_session_review_at      ON session_review(reviewed_at);
        `);
    },

    /** v15 — sync journal foundation: singleton sync_state + append-only sync_journal log. */
    15: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS sync_state (
                id                          INTEGER PRIMARY KEY CHECK (id = 1),
                device_id                   TEXT NOT NULL,
                user_hash                   TEXT,
                relay_url                   TEXT,
                last_pull_cursor            TEXT,
                last_push_cursor            TEXT,
                encryption_key_fingerprint  TEXT,
                enabled                     INTEGER NOT NULL DEFAULT 0,
                last_pull_at                TEXT,
                last_push_at                TEXT,
                last_error                  TEXT
            );

            CREATE TABLE IF NOT EXISTS sync_journal (
                sync_id      TEXT PRIMARY KEY,
                op           TEXT NOT NULL CHECK (op IN ('trajectory', 'feedback', 'truth_update', 'retire', 'concept_create')),
                entity_id    TEXT NOT NULL,
                scope_kind   TEXT NOT NULL,
                scope_key    TEXT NOT NULL,
                payload      TEXT NOT NULL,
                device_id    TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                pushed_at    TEXT,
                pulled_at    TEXT,
                applied_at   TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_journal_pushed  ON sync_journal(pushed_at);
            CREATE INDEX IF NOT EXISTS idx_journal_op      ON sync_journal(op);
            CREATE INDEX IF NOT EXISTS idx_journal_scope   ON sync_journal(scope_kind, scope_key);
            CREATE INDEX IF NOT EXISTS idx_journal_applied ON sync_journal(applied_at);
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
