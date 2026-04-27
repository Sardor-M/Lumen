import { getDb } from './database.js';
import type { Source, SourceType } from '../types/index.js';
import { DEFAULT_SCOPE_KIND, DEFAULT_SCOPE_KEY } from '../types/index.js';
import { invalidateProfile } from '../profile/invalidate.js';

/**
 * Insert input is Source minus the scope fields, with scope as optional.
 * Tier 1: callers can omit scope; the DB default (`personal:me`) applies via
 * the explicit fallback below. Tier 2 will pass real scopes from the resolver.
 */
type InsertSourceInput = Omit<Source, 'scope_kind' | 'scope_key'> &
    Partial<Pick<Source, 'scope_kind' | 'scope_key'>>;

export function insertSource(source: InsertSourceInput): void {
    getDb()
        .prepare(
            `INSERT INTO sources (id, title, url, content, content_hash, source_type, added_at, compiled_at, word_count, language, metadata, scope_kind, scope_key)
       VALUES (@id, @title, @url, @content, @content_hash, @source_type, @added_at, @compiled_at, @word_count, @language, @metadata, @scope_kind, @scope_key)`,
        )
        .run({
            ...source,
            scope_kind: source.scope_kind ?? DEFAULT_SCOPE_KIND,
            scope_key: source.scope_key ?? DEFAULT_SCOPE_KEY,
        });
    invalidateProfile();
}

export function getSource(id: string): Source | null {
    return (getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as Source) ?? null;
}

export function getSourceByHash(hash: string): Source | null {
    return (
        (getDb().prepare('SELECT * FROM sources WHERE content_hash = ?').get(hash) as Source) ??
        null
    );
}

export function listSources(opts?: { type?: SourceType; compiled?: boolean }): Source[] {
    let sql = 'SELECT * FROM sources';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.type) {
        conditions.push('source_type = ?');
        params.push(opts.type);
    }
    if (opts?.compiled === true) {
        conditions.push('compiled_at IS NOT NULL');
    } else if (opts?.compiled === false) {
        conditions.push('compiled_at IS NULL');
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY added_at DESC';

    return getDb()
        .prepare(sql)
        .all(...params) as Source[];
}

export function markCompiled(id: string): void {
    getDb()
        .prepare('UPDATE sources SET compiled_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
    invalidateProfile();
}

export function deleteSource(id: string): void {
    getDb().prepare('DELETE FROM sources WHERE id = ?').run(id);
    invalidateProfile();
}

export function countSources(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM sources').get() as { count: number };
    return row.count;
}

export function countSourcesByType(): Record<string, number> {
    const rows = getDb()
        .prepare('SELECT source_type, COUNT(*) as count FROM sources GROUP BY source_type')
        .all() as {
        source_type: string;
        count: number;
    }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
        result[row.source_type] = row.count;
    }
    return result;
}
