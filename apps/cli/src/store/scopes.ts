/**
 * Scope registry CRUD.
 *
 * The `scopes` table is a thin index of every (kind, key) pair Lumen has seen,
 * with optional human label and JSON metadata (e.g. git remote URL, root path,
 * detected dependency list). Sources and concepts carry the (kind, key) pair
 * directly; the registry exists for display, scope listing, and labelling.
 *
 * Tier 1 surface — created in v10 migration. Used by the scope resolver
 * (`apps/cli/src/scope/`) and the future `lumen scope` CLI.
 */

import { getDb } from './database.js';
import type { Scope, ScopeKind } from '../types/index.js';

export type ScopeRow = {
    kind: ScopeKind;
    key: string;
    label: string | null;
    detected_at: string;
    last_seen_at: string;
    metadata: Record<string, unknown> | null;
};

type RawScopeRow = {
    kind: string;
    key: string;
    label: string | null;
    detected_at: string;
    last_seen_at: string;
    metadata: string | null;
};

function rowToScope(row: RawScopeRow): ScopeRow {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
        try {
            metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
            metadata = null;
        }
    }
    return {
        kind: row.kind as ScopeKind,
        key: row.key,
        label: row.label,
        detected_at: row.detected_at,
        last_seen_at: row.last_seen_at,
        metadata,
    };
}

/**
 * Insert a new scope or refresh `last_seen_at` and (optionally) `label` /
 * `metadata` for an existing one. Idempotent.
 */
export function upsertScope(input: {
    kind: ScopeKind;
    key: string;
    label?: string | null;
    metadata?: Record<string, unknown> | null;
}): void {
    const now = new Date().toISOString();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    getDb()
        .prepare(
            `INSERT INTO scopes (kind, key, label, detected_at, last_seen_at, metadata)
             VALUES (@kind, @key, @label, @now, @now, @metadata)
             ON CONFLICT(kind, key) DO UPDATE SET
               label        = COALESCE(@label, scopes.label),
               metadata     = COALESCE(@metadata, scopes.metadata),
               last_seen_at = @now`,
        )
        .run({
            kind: input.kind,
            key: input.key,
            label: input.label ?? null,
            metadata: metadataJson,
            now,
        });
}

export function getScope(kind: ScopeKind, key: string): ScopeRow | null {
    const row = getDb()
        .prepare('SELECT * FROM scopes WHERE kind = ? AND key = ?')
        .get(kind, key) as RawScopeRow | undefined;
    return row ? rowToScope(row) : null;
}

export function listScopes(opts?: { kind?: ScopeKind }): ScopeRow[] {
    const sql = opts?.kind
        ? 'SELECT * FROM scopes WHERE kind = ? ORDER BY last_seen_at DESC'
        : 'SELECT * FROM scopes ORDER BY last_seen_at DESC';
    const rows = (
        opts?.kind ? getDb().prepare(sql).all(opts.kind) : getDb().prepare(sql).all()
    ) as RawScopeRow[];
    return rows.map(rowToScope);
}

/** Bump `last_seen_at` without touching label or metadata. */
export function touchScope(kind: ScopeKind, key: string): void {
    getDb()
        .prepare('UPDATE scopes SET last_seen_at = ? WHERE kind = ? AND key = ?')
        .run(new Date().toISOString(), kind, key);
}

/** Set or clear the human label for an existing scope. */
export function setScopeLabel(kind: ScopeKind, key: string, label: string | null): void {
    getDb().prepare('UPDATE scopes SET label = ? WHERE kind = ? AND key = ?').run(label, kind, key);
}

export function countScopes(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM scopes').get() as { count: number };
    return row.count;
}

/** Convenience converter from DB row to public Scope type (drops detection metadata). */
export function toScope(row: ScopeRow): Scope {
    return { kind: row.kind, key: row.key, label: row.label };
}
