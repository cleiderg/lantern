import type { Database as Db } from 'better-sqlite3';
import Database from 'better-sqlite3';

export type { Db };

/**
 * Open the Lantern database at `path` with WAL mode and FK enforcement.
 * Callers pass the path explicitly so tests can use an in-memory or temp DB.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
