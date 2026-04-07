import { getDb } from './database.js';
import type { Edge, RelationType } from '../types/index.js';

export function upsertEdge(edge: Edge): void {
    getDb()
        .prepare(
            `INSERT INTO edges (from_slug, to_slug, relation, weight, source_id)
       VALUES (@from_slug, @to_slug, @relation, @weight, @source_id)
       ON CONFLICT(from_slug, to_slug, relation) DO UPDATE SET
         weight = MAX(edges.weight, @weight),
         source_id = COALESCE(@source_id, edges.source_id)`,
        )
        .run(edge);
}

export function getEdgesFrom(slug: string): Edge[] {
    return getDb().prepare('SELECT * FROM edges WHERE from_slug = ?').all(slug) as Edge[];
}

export function getEdgesTo(slug: string): Edge[] {
    return getDb().prepare('SELECT * FROM edges WHERE to_slug = ?').all(slug) as Edge[];
}

export function getEdgesBetween(slugA: string, slugB: string): Edge[] {
    return getDb()
        .prepare(
            `SELECT * FROM edges
       WHERE (from_slug = ? AND to_slug = ?) OR (from_slug = ? AND to_slug = ?)`,
        )
        .all(slugA, slugB, slugB, slugA) as Edge[];
}

export function listEdges(): Edge[] {
    return getDb().prepare('SELECT * FROM edges ORDER BY weight DESC').all() as Edge[];
}

export function deleteEdge(fromSlug: string, toSlug: string, relation: RelationType): void {
    getDb()
        .prepare('DELETE FROM edges WHERE from_slug = ? AND to_slug = ? AND relation = ?')
        .run(fromSlug, toSlug, relation);
}

export function deleteEdgesBySource(sourceId: string): void {
    getDb().prepare('DELETE FROM edges WHERE source_id = ?').run(sourceId);
}

export function countEdges(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number };
    return row.count;
}

export function getNeighbors(slug: string): string[] {
    const rows = getDb()
        .prepare(
            `SELECT DISTINCT slug FROM (
         SELECT to_slug AS slug FROM edges WHERE from_slug = ?
         UNION
         SELECT from_slug AS slug FROM edges WHERE to_slug = ?
       )`,
        )
        .all(slug, slug) as { slug: string }[];
    return rows.map((r) => r.slug);
}
