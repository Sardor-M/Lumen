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
import { findMergeCandidate } from '../dedup/index.js';
import type { MergeCandidate } from '../dedup/index.js';
import { recordAlias, resolveAlias } from './aliases.js';
import { getStmt } from './prepared.js';
import { appendJournal } from '../sync/journal.js';

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
    const db = getDb();
    const scope_kind = concept.scope_kind ?? DEFAULT_SCOPE_KIND;
    const scope_key = concept.scope_key ?? DEFAULT_SCOPE_KEY;

    /**
     * Resolve the incoming slug through the alias table first, scoped to this
     * operation's (scope_kind, scope_key). Scope-isolation prevents an alias
     * recorded in scope A from silently redirecting a write in scope B to
     * scope A's canonical row. If no alias exists for this slug in this scope,
     * targetSlug === concept.slug and the upsert proceeds normally.
     */
    const targetSlug = resolveAlias(concept.slug, scope_kind, scope_key);

    /**
     * Merge-on-write: when the incoming slug is new (no exact-slug conflict
     * waiting to fire ON CONFLICT, and not an alias) but a near-duplicate
     * exists in the same scope, fold the incoming data into the canonical
     * concept and record an alias so future lookups for the incoming slug
     * resolve to the same row.
     *
     * Skip the scan when the slug is already known - the existing ON CONFLICT
     * path is faster and semantically identical to "the user re-captured the
     * same concept".
     */
    const knownSlug =
        targetSlug !== concept.slug ||
        (getStmt(db, 'SELECT 1 AS found FROM concepts WHERE slug = ?').get(concept.slug) as
            | { found: number }
            | undefined) !== undefined;

    if (!knownSlug) {
        const incomingContent = concept.compiled_truth ?? concept.summary ?? concept.name ?? '';
        const candidates = listMergeCandidates(scope_kind, scope_key);
        const decision = findMergeCandidate(
            { slug: concept.slug, content: incomingContent },
            candidates,
        );

        if (decision.merge) {
            mergeIntoCanonical({
                incomingSlug: concept.slug,
                canonicalSlug: decision.canonical.slug,
                scope_kind,
                scope_key,
                slug_sim: decision.slug_sim,
                content_sim: decision.content_sim,
                incomingTimeline: concept.timeline ?? [],
                updated_at: concept.updated_at,
            });
            return;
        }
    }

    /**
     * Wrap the upsert + journal append in a single transaction so a crash
     * between them can't leave the journal out of sync with the concepts
     * table. The journal append only fires on the new-insert path; the
     * ON CONFLICT update path is just a mention_count bump and not worth
     * shipping to peer devices.
     */
    const insertAndJournal = db.transaction(() => {
        db.prepare(
            `INSERT INTO concepts (slug, name, summary, compiled_truth, article, created_at, updated_at, mention_count, scope_kind, scope_key)
       VALUES (@slug, @name, @summary, @compiled_truth, @article, @created_at, @updated_at, @mention_count, @scope_kind, @scope_key)
       ON CONFLICT(slug) DO UPDATE SET
         name         = @name,
         summary      = COALESCE(@summary, concepts.summary),
         compiled_truth = COALESCE(@compiled_truth, concepts.compiled_truth),
         article      = COALESCE(@article, concepts.article),
         updated_at   = @updated_at,
         mention_count = concepts.mention_count + 1`,
        ).run({
            slug: targetSlug,
            name: concept.name,
            summary: concept.summary ?? null,
            compiled_truth: concept.compiled_truth ?? null,
            article: concept.article ?? null,
            created_at: concept.created_at,
            updated_at: concept.updated_at,
            mention_count: concept.mention_count,
            scope_kind,
            scope_key,
        });

        if (!knownSlug) {
            appendJournal({
                op: 'concept_create',
                entity_id: targetSlug,
                scope_kind,
                scope_key,
                payload: {
                    slug: targetSlug,
                    name: concept.name,
                    summary: concept.summary ?? null,
                    compiled_truth: concept.compiled_truth ?? null,
                },
            });
        }
    });
    insertAndJournal();
    invalidateProfile();
}

/**
 * Active concepts in the same scope as the incoming concept, formatted for the
 * dedup policy.
 *
 * Bounded scan: at most 200 candidates per upsert, ordered by
 * `(mention_count DESC, score DESC)`. The trade-off:
 *   - The top of that list dominates retrieval anyway (the most-mentioned
 *     and highest-scored concepts are what `brain_ops` surfaces), so a
 *     near-duplicate of any of them is what we most want to catch.
 *   - The long tail (low mention_count, low score) can't become a merge
 *     target above the 200 cap. In practice this means a fresh, never-
 *     retrieved concept won't be folded into an even fresher near-dup
 *     until one of them accumulates enough mentions to enter the top 200.
 *     This is acceptable: long-tail noise concepts rarely matter, and
 *     low-mention concepts get a chance to be the canonical themselves
 *     once they earn it.
 * If a scope routinely has > 200 active concepts AND duplicates in the
 * tail are a real issue, raise the limit or add an off-line dedup sweep.
 */
function listMergeCandidates(scope_kind: ScopeKind, scope_key: string): MergeCandidate[] {
    const rows = getStmt(
        getDb(),
        `SELECT slug,
                COALESCE(compiled_truth, summary, name, '') AS content,
                score,
                mention_count,
                retired_at
         FROM concepts
         WHERE scope_kind = ? AND scope_key = ? AND retired_at IS NULL
         ORDER BY mention_count DESC, score DESC
         LIMIT 200`,
    ).all(scope_kind, scope_key) as Array<{
        slug: string;
        content: string;
        score: number;
        mention_count: number;
        retired_at: string | null;
    }>;
    return rows;
}

/**
 * Apply the merge: bump the canonical's mention_count, append any incoming
 * timeline entries, and record the alias. The incoming slug never gets its
 * own concept row.
 */
function mergeIntoCanonical(args: {
    incomingSlug: string;
    canonicalSlug: string;
    scope_kind: ScopeKind;
    scope_key: string;
    slug_sim: number;
    content_sim: number;
    incomingTimeline: TimelineEntry[];
    updated_at: string;
}): void {
    const db = getDb();

    /**
     * Atomic merge: bump the canonical's counters, fold any incoming timeline,
     * and record the alias - or roll back the whole sequence on failure. Without
     * this, a crash between the UPDATE and the alias INSERT would leave the
     * canonical's mention_count incremented but no alias row recorded, so the
     * next upsert with the same incoming slug would re-merge and double-count.
     */
    const apply = db.transaction(() => {
        db.prepare(
            `UPDATE concepts
             SET mention_count = mention_count + 1,
                 updated_at    = ?
             WHERE slug = ?`,
        ).run(args.updated_at, args.canonicalSlug);

        if (args.incomingTimeline.length > 0) {
            for (const entry of args.incomingTimeline) {
                appendTimeline(args.canonicalSlug, entry);
            }
        }

        recordAlias({
            alias: args.incomingSlug,
            canonical_slug: args.canonicalSlug,
            scope_kind: args.scope_kind,
            scope_key: args.scope_key,
            merge_reason: `near-duplicate (slug_sim=${args.slug_sim.toFixed(2)}, content_sim=${args.content_sim.toFixed(2)})`,
        });
    });
    apply();

    invalidateProfile();
}

export function getConcept(slug: string): Concept | null {
    /**
     * Follow aliases transparently - if the caller looks up a slug that was
     * merged into a canonical, return the canonical row instead of null.
     * Single-hop: the merge path always resolves to the final canonical
     * before recording, so chains can't form.
     */
    const resolved = resolveAlias(slug);
    const row = getDb().prepare('SELECT * FROM concepts WHERE slug = ?').get(resolved) as
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
    const target = resolveAlias(slug);
    const existing = db.prepare('SELECT retired_at FROM concepts WHERE slug = ?').get(target) as
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
            target,
        );
    } else {
        db.prepare('UPDATE concepts SET score = ? WHERE slug = ?').run(score, target);
    }
    invalidateProfile();
}

/**
 * Explicitly retire a concept. Idempotent - re-retiring keeps the original
 * `retired_at` timestamp and reason intact. Journals on the *first*
 * retirement only; subsequent re-retire calls don't ship a duplicate
 * journal entry (peer devices already received the original).
 */
export function retireConcept(slug: string, reason: string): void {
    const db = getDb();
    const target = resolveAlias(slug);

    const retireAndJournal = db.transaction(() => {
        const before = db
            .prepare('SELECT retired_at, scope_kind, scope_key FROM concepts WHERE slug = ?')
            .get(target) as
            | { retired_at: string | null; scope_kind: string; scope_key: string }
            | undefined;
        if (!before) return;
        db.prepare(
            `UPDATE concepts
             SET retired_at = COALESCE(retired_at, ?),
                 retire_reason = COALESCE(retire_reason, ?)
             WHERE slug = ?`,
        ).run(new Date().toISOString(), reason, target);
        if (before.retired_at === null) {
            appendJournal({
                op: 'retire',
                entity_id: target,
                scope_kind: before.scope_kind as never,
                scope_key: before.scope_key,
                payload: { concept_slug: target, reason },
            });
        }
    });
    retireAndJournal();
    invalidateProfile();
}

/** Bring a concept back from retirement. Clears both `retired_at` and `retire_reason`. */
export function unretireConcept(slug: string): void {
    getDb()
        .prepare('UPDATE concepts SET retired_at = NULL, retire_reason = NULL WHERE slug = ?')
        .run(resolveAlias(slug));
    invalidateProfile();
}

export function updateArticle(slug: string, article: string): void {
    getDb()
        .prepare('UPDATE concepts SET article = ?, updated_at = ? WHERE slug = ?')
        .run(article, new Date().toISOString(), resolveAlias(slug));
}

/**
 * Replace the mutable compiled_truth section with a new synthesis.
 * Called by the compiler whenever new evidence materially changes the picture.
 *
 * Journals `op = 'truth_update'` so peer devices can apply LWW conflict
 * resolution on `updated_at`.
 */
export function updateCompiledTruth(slug: string, truth: string): void {
    const db = getDb();
    const target = resolveAlias(slug);
    const now = new Date().toISOString();

    const updateAndJournal = db.transaction(() => {
        const result = db
            .prepare(
                `UPDATE concepts SET compiled_truth = ?, summary = ?, updated_at = ? WHERE slug = ?`,
            )
            .run(truth, truth, now, target);
        if (result.changes === 0) return;
        const scope = db
            .prepare('SELECT scope_kind, scope_key FROM concepts WHERE slug = ?')
            .get(target) as { scope_kind: string; scope_key: string } | undefined;
        if (!scope) return;
        appendJournal({
            op: 'truth_update',
            entity_id: target,
            scope_kind: scope.scope_kind as never,
            scope_key: scope.scope_key,
            payload: {
                concept_slug: target,
                new_truth: truth,
                updated_at: now,
            },
        });
    });
    updateAndJournal();
}

/**
 * Append one entry to a concept's immutable evidence trail.
 * Never modifies existing entries — only ever appends.
 */
export function appendTimeline(slug: string, entry: TimelineEntry): void {
    const db = getDb();
    const target = resolveAlias(slug);
    const row = db.prepare('SELECT timeline FROM concepts WHERE slug = ?').get(target) as
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
        target,
    );
}

/**
 * Return the full timeline for a concept, newest first.
 * Safe to call even when timeline column is missing (pre-v6 databases).
 */
export function getTimeline(slug: string): TimelineEntry[] {
    const row = getDb()
        .prepare('SELECT timeline FROM concepts WHERE slug = ?')
        .get(resolveAlias(slug)) as { timeline?: string } | undefined;
    return parseTimeline(row?.timeline);
}

export function deleteConcept(slug: string): void {
    getDb().prepare('DELETE FROM concepts WHERE slug = ?').run(resolveAlias(slug));
}

export function countConcepts(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM concepts').get() as {
        count: number;
    };
    return row.count;
}

export function linkSourceConcept(link: SourceConcept): void {
    const resolved: SourceConcept = {
        ...link,
        concept_slug: resolveAlias(link.concept_slug),
    };
    getDb()
        .prepare(
            `INSERT INTO source_concepts (source_id, concept_slug, relevance)
       VALUES (@source_id, @concept_slug, @relevance)
       ON CONFLICT(source_id, concept_slug) DO UPDATE SET relevance = @relevance`,
        )
        .run(resolved);
}

export function getConceptSources(slug: string): string[] {
    const rows = getDb()
        .prepare(
            'SELECT source_id FROM source_concepts WHERE concept_slug = ? ORDER BY relevance DESC',
        )
        .all(resolveAlias(slug)) as { source_id: string }[];
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
