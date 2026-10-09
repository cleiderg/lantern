import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { runMigrations } from './migrate.ts';

export const LANTERN_DIR = join(homedir(), '.lantern');

/** Scaffold ~/.lantern and apply all pending migrations. */
export function initLantern(lanternDir: string = LANTERN_DIR): void {
  if (!existsSync(lanternDir)) {
    mkdirSync(lanternDir, { recursive: true });
  }
  const dbPath = join(lanternDir, 'lantern.db');
  const db = openDb(dbPath);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
}
