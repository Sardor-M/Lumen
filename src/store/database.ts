import Database from 'better-sqlite3';
import { getDbPath } from '../utils/paths.js';
import { createSchema } from './schema.js';
import { runMigrations } from './migrations.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = openDatabase(getDbPath());
  return db;
}

export function openDatabase(path: string): Database.Database {
  const instance = new Database(path);

  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('cache_size = -64000'); // 64MB
  instance.pragma('busy_timeout = 5000');

  const version = instance.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    createSchema(instance);
  } else {
    runMigrations(instance, version);
  }

  return instance;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function resetDb(): void {
  db = null;
}
