import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';

/** Every table the migrations create. */
const EXPECTED_TABLES = [
  'agents',
  'pulses',
  'sessions',
  'tickets',
  'ticket_files',
  'ticket_links',
  'ticket_events',
  'pulse_findings',
  'escalations',
  'observations',
  'playbooks',
  'playbook_runs',
  'usage_daily',
  'schema_migrations',
];

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('initLantern creates the Lantern directory and DB file', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);

    // Check directory and DB exist
    assert.ok(existsSync(lanternDir), 'Lantern dir created');
    assert.ok(existsSync(join(lanternDir, 'lantern.db')), 'lantern.db created');
  });
});

test('every table, ticket_files included, is present after init', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);

    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      const present = new Set<string>(
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type IN ('table','shadow') AND name NOT LIKE 'sqlite_%'`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name),
      );

      for (const table of EXPECTED_TABLES) {
        assert.ok(present.has(table), `table '${table}' should exist`);
      }

      // tickets_fts virtual table check
      const ftsRow = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'tickets_fts'`,
        )
        .get() as { name: string } | undefined;
      assert.ok(ftsRow !== undefined, "virtual table 'tickets_fts' should exist");
    } finally {
      db.close();
    }
  });
});

test('FTS5 triggers fire: inserted ticket is retrievable via tickets_fts MATCH', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);

    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      // Insert the minimal required data: agent first (FK), then ticket
      db.prepare(`
        INSERT INTO agents (id, display_name, config_path, mission, workdir)
        VALUES ('test', 'Test Agent', 'agents/test.agent.md', 'Testing', '/tmp')
      `).run();

      db.prepare(`
        INSERT INTO tickets (agent_id, kind, title, body, origin)
        VALUES ('test', 'bug', 'segmentation fault in renderer', 'crashes on startup', 'human')
      `).run();

      const row = db
        .prepare(`SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH 'segmentation'`)
        .get() as { rowid: number } | undefined;

      assert.ok(row !== undefined, 'FTS search should return a row');
      assert.equal(row.rowid, 1, 'returned rowid should match the inserted ticket id');
    } finally {
      db.close();
    }
  });
});

test('observations.last_pulse_id column exists', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);

    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      const cols = db.prepare('PRAGMA table_info(observations)').all() as {
        name: string;
      }[];
      const names = cols.map((c) => c.name);
      assert.ok(names.includes('last_pulse_id'), 'observations.last_pulse_id should exist');
    } finally {
      db.close();
    }
  });
});

test('initLantern is idempotent: re-running does not fail or double-apply migrations', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    initLantern(lanternDir); // second call must not throw

    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      const rows = db.prepare('SELECT filename FROM schema_migrations ORDER BY filename').all() as {
        filename: string;
      }[];
      assert.ok(rows.length >= 2, 'all migrations applied exactly once');
      assert.equal(rows[0]?.filename, '001_init.sql');
      assert.equal(rows[1]?.filename, '002_suppress_tracking.sql');
    } finally {
      db.close();
    }
  });
});
