import type Database from 'better-sqlite3';

/**
 * Increment this when adding migrations.
 * v5 — vector embeddings (vec_chunks, embedding_meta, embedding columns on chunks)
 * v6 — compiled truth + timeline (compiled_truth, timeline columns on concepts)
 * v7 — link management (concept_links table with back-link support)
 * v8 — self-improving classifiers (classifier_patterns + classifier_fallbacks tables)
 * v9 — tiered entity enrichment (enrichment_tier, last_enriched_at, enrichment_queued on concepts)
 * v10 — scope dimension (scope_kind, scope_key on sources + concepts; scopes registry table)
 * v11 — concept scoring + retirement (score, retired_at, retire_reason on concepts; concept_feedback table)
 * v12 — concept_aliases table (merge near-duplicates on write; aliases follow to canonical)
 * v13 — exploration-cost telemetry (tokens_spent, skill_hit, exploration_depth, scope_kind, scope_key on query_log)
 * v14 — trajectory review pass (session_review table — records per-session LLM extraction outcomes)
 */
const CURRENT_VERSION = 14;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'url',
    added_at TEXT NOT NULL,
    compiled_at TEXT,
    word_count INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    metadata TEXT,
    scope_kind TEXT NOT NULL DEFAULT 'personal',
    scope_key  TEXT NOT NULL DEFAULT 'me'
  );

  CREATE INDEX IF NOT EXISTS idx_sources_content_hash ON sources(content_hash);
  CREATE INDEX IF NOT EXISTS idx_sources_source_type ON sources(source_type);
  CREATE INDEX IF NOT EXISTS idx_sources_compiled_at ON sources(compiled_at);
  CREATE INDEX IF NOT EXISTS idx_sources_scope ON sources(scope_kind, scope_key);

  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_type TEXT NOT NULL DEFAULT 'paragraph',
    heading TEXT,
    position INTEGER NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    embedding_model TEXT,
    embedded_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_source_id ON chunks(source_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='rowid',
    tokenize='porter'
  );

  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE IF NOT EXISTS concepts (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    summary TEXT,
    compiled_truth TEXT,
    timeline TEXT NOT NULL DEFAULT '[]',
    article TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 0,
    enrichment_tier   INTEGER NOT NULL DEFAULT 3,
    last_enriched_at  TEXT,
    enrichment_queued INTEGER NOT NULL DEFAULT 0,
    scope_kind TEXT NOT NULL DEFAULT 'personal',
    scope_key  TEXT NOT NULL DEFAULT 'me',
    score         INTEGER NOT NULL DEFAULT 0,
    retired_at    TEXT,
    retire_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_concepts_scope    ON concepts(scope_kind, scope_key);
  CREATE INDEX IF NOT EXISTS idx_concepts_score    ON concepts(score);
  CREATE INDEX IF NOT EXISTS idx_concepts_retired  ON concepts(retired_at);

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

  CREATE TABLE IF NOT EXISTS scopes (
    kind         TEXT NOT NULL,
    key          TEXT NOT NULL,
    label        TEXT,
    detected_at  TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    metadata     TEXT,
    PRIMARY KEY (kind, key)
  );

  CREATE TABLE IF NOT EXISTS edges (
    from_slug TEXT NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
    to_slug TEXT NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    source_id TEXT,
    PRIMARY KEY (from_slug, to_slug, relation)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_slug);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);

  CREATE TABLE IF NOT EXISTS source_concepts (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    concept_slug TEXT NOT NULL REFERENCES concepts(slug) ON DELETE CASCADE,
    relevance REAL NOT NULL DEFAULT 0.0,
    PRIMARY KEY (source_id, concept_slug)
  );

  CREATE TABLE IF NOT EXISTS query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    query_text TEXT,
    result_count INTEGER,
    latency_ms INTEGER,
    session_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    tokens_spent INTEGER,
    skill_hit INTEGER NOT NULL DEFAULT 0,
    exploration_depth INTEGER,
    scope_kind TEXT,
    scope_key TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_query_log_tool ON query_log(tool_name);
  CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_query_log_skill_hit ON query_log(skill_hit);
  CREATE INDEX IF NOT EXISTS idx_query_log_scope ON query_log(scope_kind, scope_key);

  CREATE TABLE IF NOT EXISTS session_review (
    session_id    TEXT PRIMARY KEY,
    reviewed_at   TEXT NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('extracted', 'no_skill', 'failed', 'skipped')),
    trajectory_id TEXT,
    notes         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_session_review_outcome ON session_review(outcome);
  CREATE INDEX IF NOT EXISTS idx_session_review_at      ON session_review(reviewed_at);

  CREATE TABLE IF NOT EXISTS profile_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    valid INTEGER NOT NULL DEFAULT 1
  );

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

  CREATE TABLE IF NOT EXISTS embedding_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
`;

/**
 * SCHEMA_VEC is separated because vec0 requires sqlite-vec to be loaded first.
 * Called from createSchema() and migration v5 only when the extension is available.
 */
const SCHEMA_VEC = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[1536]
  );
`;

export function createSchema(db: Database.Database, vecAvailable: boolean): void {
    db.exec(SCHEMA);
    if (vecAvailable) db.exec(SCHEMA_VEC);
    db.pragma(`user_version = ${CURRENT_VERSION}`);
}

export { CURRENT_VERSION, SCHEMA_VEC };
