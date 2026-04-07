import type Database from 'better-sqlite3';

const CURRENT_VERSION = 1;

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
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sources_content_hash ON sources(content_hash);
  CREATE INDEX IF NOT EXISTS idx_sources_source_type ON sources(source_type);
  CREATE INDEX IF NOT EXISTS idx_sources_compiled_at ON sources(compiled_at);

  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_type TEXT NOT NULL DEFAULT 'paragraph',
    heading TEXT,
    position INTEGER NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0
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
    article TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 0
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
`;

export function createSchema(db: Database.Database): void {
    db.exec(SCHEMA);
    db.pragma(`user_version = ${CURRENT_VERSION}`);
}

export { CURRENT_VERSION };
