import { getDb } from './database.js';
import { resolveAlias } from './aliases.js';
import type { ConceptLink, LinkType } from '../types/index.js';

/**
 * Insert a directional link between two concepts. Silently ignores duplicates.
 * Both slugs are resolved through the alias table first so callers passing an
 * aliased slug land the link on the canonical concept.
 */
export function addLink(
    fromSlug: string,
    toSlug: string,
    linkType: LinkType,
    context: string | null = null,
    sourceId: string | null = null,
): void {
    const from = resolveAlias(fromSlug);
    const to = resolveAlias(toSlug);
    getDb()
        .prepare(
            `INSERT OR IGNORE INTO concept_links
               (from_slug, to_slug, link_type, context, source_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(from, to, linkType, context, sourceId, new Date().toISOString());
}

/**
 * Add a reference link from A → B and the corresponding back-link from B → A.
 * Call this when concept A's compiled_truth explicitly mentions concept B.
 */
export function addBackLink(
    fromSlug: string,
    toSlug: string,
    context: string | null = null,
    sourceId: string | null = null,
): void {
    addLink(fromSlug, toSlug, 'reference', context, sourceId);
    addLink(toSlug, fromSlug, 'back-link', context, sourceId);
}

/** Remove a specific directional link. */
export function removeLink(fromSlug: string, toSlug: string, linkType: LinkType): void {
    getDb()
        .prepare(
            `DELETE FROM concept_links
             WHERE from_slug = ? AND to_slug = ? AND link_type = ?`,
        )
        .run(resolveAlias(fromSlug), resolveAlias(toSlug), linkType);
}

/** Get all outgoing links from a concept, optionally filtered by type. */
export function getLinksFrom(slug: string, type?: LinkType): ConceptLink[] {
    const resolved = resolveAlias(slug);
    const db = getDb();
    if (type) {
        return db
            .prepare(
                `SELECT * FROM concept_links
                 WHERE from_slug = ? AND link_type = ?
                 ORDER BY id DESC`,
            )
            .all(resolved, type) as ConceptLink[];
    }
    return db
        .prepare(
            `SELECT * FROM concept_links
             WHERE from_slug = ?
             ORDER BY id DESC`,
        )
        .all(resolved) as ConceptLink[];
}

/** Get all links that point TO a concept — the back-link index. */
export function getBackLinks(slug: string): ConceptLink[] {
    const resolved = resolveAlias(slug);
    return getDb()
        .prepare(
            `SELECT * FROM concept_links
             WHERE to_slug = ?
             ORDER BY created_at DESC`,
        )
        .all(resolved) as ConceptLink[];
}

export function countLinks(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM concept_links').get() as { n: number };
    return row.n;
}

/**
 * Scan a concept's compiled_truth for mentions of other known concepts
 * and automatically create reference + back-links.
 * Called by the compiler after all concepts from a source are upserted.
 * `sourceId` may be null in tests or when the source FK is not available.
 */
export function autoLinkFromCompiledTruth(
    slug: string,
    compiledTruth: string,
    sourceId: string | null,
): void {
    const db = getDb();
    const allSlugs = (
        db.prepare('SELECT slug FROM concepts WHERE slug != ?').all(slug) as { slug: string }[]
    ).map((r) => r.slug);

    const lowerTruth = compiledTruth.toLowerCase();

    for (const targetSlug of allSlugs) {
        const humanName = targetSlug.replace(/-/g, ' ');
        if (lowerTruth.includes(humanName) || lowerTruth.includes(targetSlug)) {
            /** Limit context to first 200 chars to keep storage lean. */
            addBackLink(slug, targetSlug, compiledTruth.slice(0, 200), sourceId);
        }
    }
}
