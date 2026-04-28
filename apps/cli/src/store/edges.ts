import { getDb } from './database.js';
import { resolveAlias } from './aliases.js';
import type { Edge, RelationType } from '../types/index.js';
import { invalidateProfile } from '../profile/invalidate.js';

export function upsertEdge(edge: Edge): void {
    const resolved: Edge = {
        ...edge,
        from_slug: resolveAlias(edge.from_slug),
        to_slug: resolveAlias(edge.to_slug),
    };
    getDb()
        .prepare(
            `INSERT INTO edges (from_slug, to_slug, relation, weight, source_id)
       VALUES (@from_slug, @to_slug, @relation, @weight, @source_id)
       ON CONFLICT(from_slug, to_slug, relation) DO UPDATE SET
         weight = MAX(edges.weight, @weight),
         source_id = COALESCE(@source_id, edges.source_id)`,
        )
        .run(resolved);
    invalidateProfile();
}

export function getEdgesFrom(slug: string): Edge[] {
    return getDb()
        .prepare('SELECT * FROM edges WHERE from_slug = ?')
        .all(resolveAlias(slug)) as Edge[];
}

export function getEdgesTo(slug: string): Edge[] {
    return getDb()
        .prepare('SELECT * FROM edges WHERE to_slug = ?')
        .all(resolveAlias(slug)) as Edge[];
}

export function getEdgesBetween(slugA: string, slugB: string): Edge[] {
    const a = resolveAlias(slugA);
    const b = resolveAlias(slugB);
    return getDb()
        .prepare(
            `SELECT * FROM edges
       WHERE (from_slug = ? AND to_slug = ?) OR (from_slug = ? AND to_slug = ?)`,
        )
        .all(a, b, b, a) as Edge[];
}

export function listEdges(): Edge[] {
    return getDb().prepare('SELECT * FROM edges ORDER BY weight DESC').all() as Edge[];
}

export function deleteEdge(fromSlug: string, toSlug: string, relation: RelationType): void {
    getDb()
        .prepare('DELETE FROM edges WHERE from_slug = ? AND to_slug = ? AND relation = ?')
        .run(resolveAlias(fromSlug), resolveAlias(toSlug), relation);
}

export function deleteEdgesBySource(sourceId: string): void {
    getDb().prepare('DELETE FROM edges WHERE source_id = ?').run(sourceId);
}

export function countEdges(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number };
    return row.count;
}

export function getNeighbors(slug: string): string[] {
    const resolved = resolveAlias(slug);
    const rows = getDb()
        .prepare(
            `SELECT DISTINCT slug FROM (
         SELECT to_slug AS slug FROM edges WHERE from_slug = ?
         UNION
         SELECT from_slug AS slug FROM edges WHERE to_slug = ?
       )`,
        )
        .all(resolved, resolved) as { slug: string }[];
    return rows.map((r) => r.slug);
}
