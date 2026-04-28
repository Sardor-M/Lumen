import { getDb } from './database.js';
import type {
    Concept,
    ScopeKind,
    SourceConcept,
    TimelineEntry,
    EnrichmentTier,
} from '../types/index.js';
import { DEFAULT_SCOPE_KIND, DEFAULT_SCOPE_KEY, RETIRE_THRESHOLD } from '../types/index.js';
import { invalidateProfile } from '../profile/invalidate.js';

/** Parse the raw `timeline` JSON column into a typed array, newest first. */
function parseTimeline(raw: unknown): TimelineEntry[] {
    if (!raw || raw === '[]') return [];
    try {
        const entries = JSON.parse(raw as string) as TimelineEntry[];
        return entries.slice().reverse();
    } catch {
        return [];
    }
}

/** Map a raw DB row to a typed Concept, parsing the timeline JSON. */
function rowToConcept(row: Record<string, unknown>): Concept {
    return {
        slug: row.slug as string,
        name: row.name as string,
        summary: (row.summary as string | null) ?? null,
        compiled_truth: (row.compiled_truth as string | null) ?? null,
        timeline: parseTimeline(row.timeline),
        article: (row.article as string | null) ?? null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        mention_count: row.mention_count as number,
        enrichment_tier: ((row.enrichment_tier as number) ?? 3) as EnrichmentTier,
        last_enriched_at: (row.last_enriched_at as string | null) ?? null,
        enrichment_queued: (row.enrichment_queued as number) ?? 0,
        scope_kind: ((row.scope_kind as ScopeKind | null) ?? DEFAULT_SCOPE_KIND) as ScopeKind,
        scope_key: (row.scope_key as string | null) ?? DEFAULT_SCOPE_KEY,
        score: (row.score as number | null) ?? 0,
        retired_at: (row.retired_at as string | null) ?? null,
        retire_reason: (row.retire_reason as string | null) ?? null,
    };
}

export function upsertConcept(
    concept: Omit<
        Concept,
        | 'timeline'
        | 'enrichment_tier'
        | 'last_enriched_at'
        | 'enrichment_queued'
        | 'scope_kind'
        | 'scope_key'
        | 'score'
        | 'retired_at'
        | 'retire_reason'
    > & {
        timeline?: TimelineEntry[];
        scope_kind?: ScopeKind;
        scope_key?: string;
    },
): void {
    getDb()
        .prepare(
            `INSERT INTO concepts (slug, name, summary, compiled_truth, article, created_at, updated_at, mention_count, scope_kind, scope_key)
       VALUES (@slug, @name, @summary, @compiled_truth, @article, @created_at, @updated_at, @mention_count, @scope_kind, @scope_key)
       ON CONFLICT(slug) DO UPDATE SET
         name         = @name,
         summary      = COALESCE(@summary, concepts.summary),
         compiled_truth = COALESCE(@compiled_truth, concepts.compiled_truth),
         article      = COALESCE(@article, concepts.article),
         updated_at   = @updated_at,
         mention_count = concepts.mention_count + 1`,
        )
        .run({
            slug: concept.slug,
            name: concept.name,
            summary: concept.summary ?? null,
            compiled_truth: concept.compiled_truth ?? null,
            article: concept.article ?? null,
            created_at: concept.created_at,
            updated_at: concept.updated_at,
            mention_count: concept.mention_count,
            scope_kind: concept.scope_kind ?? DEFAULT_SCOPE_KIND,
            scope_key: concept.scope_key ?? DEFAULT_SCOPE_KEY,
        });
    invalidateProfile();
}

export function getConcept(slug: string): Concept | null {
    const row = getDb().prepare('SELECT * FROM concepts WHERE slug = ?').get(slug) as
        | Record<string, unknown>
        | undefined;
    return row ? rowToConcept(row) : null;
}

/**
 * Return the concept only when active (not retired). Use this from skill-substrate
 * paths like brain_ops where retired concepts should be invisible. The plain
 * `getConcept` still returns retired rows so explicit lookups can surface
 * `retired_at` / `retire_reason` to the agent.
 */
export function getActiveConcept(slug: string): Concept | null {
    const concept = getConcept(slug);
    if (!concept || concept.retired_at !== null) return null;
    return concept;
}

export function listConcepts(): Concept[] {
    const rows = getDb()
        .prepare('SELECT * FROM concepts ORDER BY mention_count DESC')
        .all() as Record<string, unknown>[];
    return rows.map(rowToConcept);
}

/**
 * Overwrite the cumulative score for a concept. Auto-retires when the new
 * score crosses the retire threshold (using `reason` if provided, else a
 * generic system reason). Idempotent - calling with an already-retired
 * concept's score below threshold does not re-stamp `retired_at`.
 */
export function updateScore(slug: string, score: number, reason?: string | null): void {
    const db = getDb();
    const existing = db.prepare('SELECT retired_at FROM concepts WHERE slug = ?').get(slug) as
        | { retired_at: string | null }
        | undefined;
    if (!existing) return;

    const shouldRetire = score <= RETIRE_THRESHOLD && existing.retired_at === null;

    if (shouldRetire) {
        db.prepare(
            `UPDATE concepts
             SET score = ?, retired_at = ?, retire_reason = ?
             WHERE slug = ?`,
        ).run(
            score,
            new Date().toISOString(),
            reason ?? 'auto-retired: score below threshold',
            slug,
        );
    } else {
        db.prepare('UPDATE concepts SET score = ? WHERE slug = ?').run(score, slug);
    }
    invalidateProfile();
}

/**
 * Explicitly retire a concept. Idempotent - re-retiring keeps the original
 * `retired_at` timestamp and reason intact.
 */
export function retireConcept(slug: string, reason: string): void {
    const db = getDb();
    db.prepare(
        `UPDATE concepts
         SET retired_at = COALESCE(retired_at, ?),
             retire_reason = COALESCE(retire_reason, ?)
         WHERE slug = ?`,
    ).run(new Date().toISOString(), reason, slug);
    invalidateProfile();
}

/** Bring a concept back from retirement. Clears both `retired_at` and `retire_reason`. */
export function unretireConcept(slug: string): void {
    getDb()
        .prepare('UPDATE concepts SET retired_at = NULL, retire_reason = NULL WHERE slug = ?')
        .run(slug);
    invalidateProfile();
}

export function updateArticle(slug: string, article: string): void {
    getDb()
        .prepare('UPDATE concepts SET article = ?, updated_at = ? WHERE slug = ?')
        .run(article, new Date().toISOString(), slug);
}

/**
 * Replace the mutable compiled_truth section with a new synthesis.
 * Called by the compiler whenever new evidence materially changes the picture.
 */
export function updateCompiledTruth(slug: string, truth: string): void {
    getDb()
        .prepare(
            `UPDATE concepts SET compiled_truth = ?, summary = ?, updated_at = ? WHERE slug = ?`,
        )
        .run(truth, truth, new Date().toISOString(), slug);
}

/**
 * Append one entry to a concept's immutable evidence trail.
 * Never modifies existing entries — only ever appends.
 */
export function appendTimeline(slug: string, entry: TimelineEntry): void {
    const db = getDb();
    const row = db.prepare('SELECT timeline FROM concepts WHERE slug = ?').get(slug) as
        | { timeline: string }
        | undefined;

    if (!row) return;

    let existing: TimelineEntry[] = [];
    try {
        existing = JSON.parse(row.timeline) as TimelineEntry[];
    } catch {
        existing = [];
    }

    existing.push(entry);

    db.prepare('UPDATE concepts SET timeline = ?, updated_at = ? WHERE slug = ?').run(
        JSON.stringify(existing),
        new Date().toISOString(),
        slug,
    );
}

/**
 * Return the full timeline for a concept, newest first.
 * Safe to call even when timeline column is missing (pre-v6 databases).
 */
export function getTimeline(slug: string): TimelineEntry[] {
    const row = getDb().prepare('SELECT timeline FROM concepts WHERE slug = ?').get(slug) as
        | { timeline?: string }
        | undefined;
    return parseTimeline(row?.timeline);
}

export function deleteConcept(slug: string): void {
    getDb().prepare('DELETE FROM concepts WHERE slug = ?').run(slug);
}

export function countConcepts(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM concepts').get() as {
        count: number;
    };
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
        .prepare(
            'SELECT source_id FROM source_concepts WHERE concept_slug = ? ORDER BY relevance DESC',
        )
        .all(slug) as { source_id: string }[];
    return rows.map((r) => r.source_id);
}

export function getSourceConcepts(sourceId: string): string[] {
    const rows = getDb()
        .prepare(
            'SELECT concept_slug FROM source_concepts WHERE source_id = ? ORDER BY relevance DESC',
        )
        .all(sourceId) as { concept_slug: string }[];
    return rows.map((r) => r.concept_slug);
}
