import type Database from 'better-sqlite3';
import { CURRENT_VERSION } from './schema.js';

type Migration = (db: Database.Database) => void;

const migrations: Record<number, Migration> = {
    /**
     * Future migrations will be added here, keyed by target version:
     * 2: (db) => { db.exec(`ALTER TABLE sources ADD COLUMN new_col TEXT`); },
     */
};

export function runMigrations(db: Database.Database, fromVersion: number): void {
    if (fromVersion >= CURRENT_VERSION) return;

    db.exec('BEGIN');
    try {
        for (let v = fromVersion + 1; v <= CURRENT_VERSION; v++) {
            const migrate = migrations[v];
            if (migrate) migrate(db);
        }
        db.pragma(`user_version = ${CURRENT_VERSION}`);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
