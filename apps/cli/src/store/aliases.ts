/**
 * Concept alias CRUD.
 *
 * When `upsertConcept` detects a near-duplicate, it inserts the incoming slug
 * as an alias pointing at the existing canonical concept. Future calls to
 * `getConcept(alias)` follow the pointer and return the canonical row, so
 * agents that captured a slightly different name see one consistent skill.
 *
 * Scope semantics: the alias table PRIMARY KEY is `alias` alone. `resolveAlias`
 * accepts optional scope params; when provided the lookup is scope-isolated —
 * an alias recorded in scope A will not redirect a write in scope B. Write paths
 * (`upsertConcept`) always pass scope to prevent cross-scope data corruption.
 * Read-path callers (`getConcept`, FK-boundary functions) omit scope, which is
 * safe because concept slugs are globally unique (PK in the concepts table), so
 * following an alias at read time never lands on the wrong row.
 */

import { getDb } from './database.js';
import { getStmt } from './prepared.js';
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
 *
 * Defensive guard: refuses to record an alias whose `canonical_slug` is itself
 * already an alias. Aliases must always point at a real concept row, never
 * at another alias - otherwise `resolveAlias`'s single-hop guarantee breaks.
 * The merge path always resolves to the final canonical before calling here,
 * so this should never fire in practice; it exists to catch future bugs in
 * any new caller.
 */
export function recordAlias(input: {
    alias: string;
    canonical_slug: string;
    scope_kind: ScopeKind;
    scope_key: string;
    merge_reason?: string | null;
}): void {
    const db = getDb();

    const canonicalIsAlias = getStmt(
        db,
        'SELECT 1 AS found FROM concept_aliases WHERE alias = ?',
    ).get(input.canonical_slug) as { found: number } | undefined;
    if (canonicalIsAlias) {
        throw new Error(
            `recordAlias: refusing to chain - canonical_slug "${input.canonical_slug}" is itself an alias. ` +
                `Resolve to the final canonical before calling recordAlias().`,
        );
    }

    const now = new Date().toISOString();
    getStmt(
        db,
        `INSERT INTO concept_aliases (alias, canonical_slug, scope_kind, scope_key, merged_at, merge_reason)
         VALUES (@alias, @canonical_slug, @scope_kind, @scope_key, @merged_at, @merge_reason)
         ON CONFLICT(alias) DO NOTHING`,
    ).run({
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
 * When `scopeKind` and `scopeKey` are provided the lookup is scope-isolated:
 * only an alias recorded for that exact scope is followed. Pass scope on write
 * paths to prevent one scope's merge from silently redirecting another scope's
 * upsert. Omit scope on read paths (getConcept, FK-boundary functions) where
 * globally-unique slugs make cross-scope confusion impossible.
 *
 * Single-hop: aliases never chain. The merge path on `upsertConcept` always
 * resolves through to the final canonical before recording, so a chain like
 * A → B → C is impossible.
 */
export function resolveAlias(slug: string, scopeKind?: ScopeKind, scopeKey?: string): string {
    const db = getDb();
    if (scopeKind !== undefined && scopeKey !== undefined) {
        const row = getStmt(
            db,
            'SELECT canonical_slug FROM concept_aliases WHERE alias = ? AND scope_kind = ? AND scope_key = ?',
        ).get(slug, scopeKind, scopeKey) as { canonical_slug: string } | undefined;
        return row?.canonical_slug ?? slug;
    }
    const row = getStmt(db, 'SELECT canonical_slug FROM concept_aliases WHERE alias = ?').get(
        slug,
    ) as { canonical_slug: string } | undefined;
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
