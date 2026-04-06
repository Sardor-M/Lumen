import { getDb } from './database.js';
import type { Chunk } from '../types/index.js';

export function insertChunks(chunks: Chunk[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO chunks (id, source_id, content, content_hash, chunk_type, heading, position, token_count)
     VALUES (@id, @source_id, @content, @content_hash, @chunk_type, @heading, @position, @token_count)`,
  );
  const tx = getDb().transaction((items: Chunk[]) => {
    for (const chunk of items) stmt.run(chunk);
  });
  tx(chunks);
}

export function getChunksBySource(sourceId: string): Chunk[] {
  return getDb()
    .prepare('SELECT * FROM chunks WHERE source_id = ? ORDER BY position')
    .all(sourceId) as Chunk[];
}

export function getChunk(id: string): Chunk | null {
  return (getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(id) as Chunk) ?? null;
}

export function searchChunksFts(query: string, limit = 20): (Chunk & { rank: number })[] {
  /**
   * Here we quote each term so FTS5 doesn't misinterpret hyphens/special chars as operators
   */
  const escaped = query
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
  return getDb()
    .prepare(
      `SELECT c.*, f.rank
       FROM chunks_fts f
       JOIN chunks c ON c.rowid = f.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
    )
    .all(escaped, limit) as (Chunk & { rank: number })[];
}

export function deleteChunksBySource(sourceId: string): void {
  getDb().prepare('DELETE FROM chunks WHERE source_id = ?').run(sourceId);
}

export function countChunks(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };
  return row.count;
}

export function totalTokens(): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM chunks')
    .get() as { total: number };
  return row.total;
}
