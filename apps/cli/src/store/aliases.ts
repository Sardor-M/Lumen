/**
 * Concept alias CRUD.
 *
 * When `upsertConcept` detects a near-duplicate, it inserts the incoming slug
 * as an alias pointing at the existing canonical concept. Future calls to
 * `getConcept(alias)` follow the pointer and return the canonical row, so
 * agents that captured a slightly different name see one consistent skill.
 *
 * Scope semantics (load-bearing): the alias table's PRIMARY KEY is `alias`
 * alone, NOT `(alias, scope_kind, scope_key)`. This means an alias slug is
 * GLOBALLY unique - if the same alias slug appears as a near-duplicate in
 * two scopes, only the first scope's merge is recorded; the second scope's
 * merge no-ops via `ON CONFLICT DO NOTHING`. The trade-off is intentional:
 *   - The merge path scopes its candidate scan, so cross-scope concepts
 *     never compare against each other - the only way the same alias slug
 *     fires in two scopes is if the agent independently captured the same
 *     literal slug in both, which is rare.
 *   - Cross-scope alias resolution would require threading scope through
 *     every `resolveAlias()` call site (every FK boundary) - much larger
 *     surface area for a problem that doesn't occur in practice.
 * If cross-scope collisions ever become a real issue, widen the PK and
 * extend `resolveAlias(slug, scope_kind, scope_key)` accordingly.
 */

import { getDb } from './database.js';
import type { ScopeKind } from '../types/index.js';

export type AliasRow = {
    alias: string;
    canonical_slug: string;
    scope_kind: ScopeKind;
    scope_key: string;
    merged_at: string;
    merge_reason: string | null;
};

type RawAliasRow = {
    alias: string;
    canonical_slug: string;
    scope_kind: string;
    scope_key: string;
    merged_at: string;
    merge_reason: string | null;
};

function rowToAlias(row: RawAliasRow): AliasRow {
    return {
        alias: row.alias,
        canonical_slug: row.canonical_slug,
        scope_kind: row.scope_kind as ScopeKind,
        scope_key: row.scope_key,
        merged_at: row.merged_at,
        merge_reason: row.merge_reason,
    };
}

/**
 * Record a new alias. Idempotent: re-inserting the same alias keeps the
 * original `canonical_slug` and `merged_at` (first writer wins).
 */
export function recordAlias(input: {
    alias: string;
    canonical_slug: string;
    scope_kind: ScopeKind;
    scope_key: string;
    merge_reason?: string | null;
}): void {
    const now = new Date().toISOString();
    getDb()
        .prepare(
            `INSERT INTO concept_aliases (alias, canonical_slug, scope_kind, scope_key, merged_at, merge_reason)
             VALUES (@alias, @canonical_slug, @scope_kind, @scope_key, @merged_at, @merge_reason)
             ON CONFLICT(alias) DO NOTHING`,
        )
        .run({
            alias: input.alias,
            canonical_slug: input.canonical_slug,
            scope_kind: input.scope_kind,
            scope_key: input.scope_key,
            merged_at: now,
            merge_reason: input.merge_reason ?? null,
        });
}

/**
 * Resolve a slug through the alias table. Returns the canonical slug when an
 * alias exists, or the input slug unchanged when no alias points at it.
 *
 * Single-hop: aliases never chain. The merge path on `upsertConcept` always
 * resolves through to the final canonical before recording, so a chain like
 * A → B → C is impossible.
 */
export function resolveAlias(slug: string): string {
    const row = getDb()
        .prepare('SELECT canonical_slug FROM concept_aliases WHERE alias = ?')
        .get(slug) as { canonical_slug: string } | undefined;
    return row?.canonical_slug ?? slug;
}

/** All aliases pointing at a canonical slug. Useful for `lumen concept inspect`. */
export function listAliases(canonical_slug: string): AliasRow[] {
    const rows = getDb()
        .prepare('SELECT * FROM concept_aliases WHERE canonical_slug = ? ORDER BY merged_at DESC')
        .all(canonical_slug) as RawAliasRow[];
    return rows.map(rowToAlias);
}

export function countAliases(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS count FROM concept_aliases').get() as {
        count: number;
    };
    return row.count;
}
