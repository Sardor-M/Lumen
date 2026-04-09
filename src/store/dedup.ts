import type Database from 'better-sqlite3';
import { contentHash } from '../utils/hash.js';

export function sourceExists(db: Database.Database, content: string): string | null {
    const hash = contentHash(content);
    const row = db.prepare('SELECT id FROM sources WHERE content_hash = ?').get(hash) as
        | { id: string }
        | undefined;
    return row?.id ?? null;
}

export function chunkExists(db: Database.Database, content: string): string | null {
    const hash = contentHash(content);
    const row = db.prepare('SELECT id FROM chunks WHERE content_hash = ?').get(hash) as
        | { id: string }
        | undefined;
    return row?.id ?? null;
}
