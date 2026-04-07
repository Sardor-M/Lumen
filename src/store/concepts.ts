import { getDb } from './database.js';
import type { Concept, SourceConcept } from '../types/index.js';

export function upsertConcept(concept: Concept): void {
    getDb()
        .prepare(
            `INSERT INTO concepts (slug, name, summary, article, created_at, updated_at, mention_count)
       VALUES (@slug, @name, @summary, @article, @created_at, @updated_at, @mention_count)
       ON CONFLICT(slug) DO UPDATE SET
         name = @name,
         summary = COALESCE(@summary, concepts.summary),
         article = COALESCE(@article, concepts.article),
         updated_at = @updated_at,
         mention_count = concepts.mention_count + 1`,
        )
        .run(concept);
}

export function getConcept(slug: string): Concept | null {
    return (getDb().prepare('SELECT * FROM concepts WHERE slug = ?').get(slug) as Concept) ?? null;
}

export function listConcepts(): Concept[] {
    return getDb().prepare('SELECT * FROM concepts ORDER BY mention_count DESC').all() as Concept[];
}

export function updateArticle(slug: string, article: string): void {
    getDb()
        .prepare('UPDATE concepts SET article = ?, updated_at = ? WHERE slug = ?')
        .run(article, new Date().toISOString(), slug);
}

export function deleteConcept(slug: string): void {
    getDb().prepare('DELETE FROM concepts WHERE slug = ?').run(slug);
}

export function countConcepts(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM concepts').get() as { count: number };
    return row.count;
}

export function linkSourceConcept(link: SourceConcept): void {
    getDb()
        .prepare(
            `INSERT INTO source_concepts (source_id, concept_slug, relevance)
       VALUES (@source_id, @concept_slug, @relevance)
       ON CONFLICT(source_id, concept_slug) DO UPDATE SET relevance = @relevance`,
        )
        .run(link);
}

export function getConceptSources(slug: string): string[] {
    const rows = getDb()
        .prepare('SELECT source_id FROM source_concepts WHERE concept_slug = ? ORDER BY relevance DESC')
        .all(slug) as { source_id: string }[];
    return rows.map((r) => r.source_id);
}

export function getSourceConcepts(sourceId: string): string[] {
    const rows = getDb()
        .prepare('SELECT concept_slug FROM source_concepts WHERE source_id = ? ORDER BY relevance DESC')
        .all(sourceId) as { concept_slug: string }[];
    return rows.map((r) => r.concept_slug);
}
