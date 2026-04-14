import { getDb } from './database.js';
import type { Connector, ConnectorType } from '../types/index.js';

export function insertConnector(connector: Connector): void {
    getDb()
        .prepare(
            `INSERT INTO connectors
                (id, type, name, config, state, interval_seconds, last_run_at, last_error, created_at)
             VALUES
                (@id, @type, @name, @config, @state, @interval_seconds, @last_run_at, @last_error, @created_at)`,
        )
        .run(connector);
}

export function getConnector(id: string): Connector | null {
    return (getDb().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector) ?? null;
}

export function listConnectors(opts?: { type?: ConnectorType }): Connector[] {
    if (opts?.type) {
        return getDb()
            .prepare('SELECT * FROM connectors WHERE type = ? ORDER BY created_at DESC')
            .all(opts.type) as Connector[];
    }
    return getDb()
        .prepare('SELECT * FROM connectors ORDER BY created_at DESC')
        .all() as Connector[];
}

export function deleteConnector(id: string): boolean {
    const res = getDb().prepare('DELETE FROM connectors WHERE id = ?').run(id);
    return res.changes > 0;
}

export function countConnectors(): number {
    const row = getDb().prepare('SELECT COUNT(*) as count FROM connectors').get() as {
        count: number;
    };
    return row.count;
}

/** Update the cursor and last-run timestamp after a successful pull. */
export function recordRunSuccess(id: string, newState: Record<string, unknown>): void {
    getDb()
        .prepare(
            `UPDATE connectors
             SET state = ?, last_run_at = ?, last_error = NULL
             WHERE id = ?`,
        )
        .run(JSON.stringify(newState), new Date().toISOString(), id);
}

/** Record a failed pull without touching cursor state. */
export function recordRunFailure(id: string, errorMessage: string): void {
    getDb()
        .prepare(
            `UPDATE connectors
             SET last_run_at = ?, last_error = ?
             WHERE id = ?`,
        )
        .run(new Date().toISOString(), errorMessage, id);
}

/** Connectors whose last run is older than `interval_seconds` ago (or never ran). */
export function dueConnectors(now = new Date()): Connector[] {
    return getDb()
        .prepare(
            `SELECT * FROM connectors
             WHERE last_run_at IS NULL
                OR (strftime('%s', ?) - strftime('%s', last_run_at)) >= interval_seconds
             ORDER BY last_run_at ASC NULLS FIRST`,
        )
        .all(now.toISOString()) as Connector[];
}
