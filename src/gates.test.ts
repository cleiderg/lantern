import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { openDb } from './db.ts';
import {
  checkDailySpend,
  checkKillSwitch,
  checkLiveChildren,
  checkNoPulseRunning,
  checkQuietHours,
  checkWorkingTree,
  runGates,
} from './gates.ts';
import { runMigrations } from './migrate.ts';
import { createRunningPulse, createSkippedPulse } from './store/pulses.ts';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-gates-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  return { db, dir };
}

// ── Gate 1: kill switch ───────────────────────────────────────────────────────

test('gate 1 fails when PAUSED file exists → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  writeFileSync(join(dir, 'PAUSED'), '');

  const result = checkKillSwitch(dir, 'running');
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /PAUSED/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /PAUSED/);

  rmSync(dir, { recursive: true });
});

test('gate 1 fails when agent state is not running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-g1-'));
  const result = checkKillSwitch(dir, 'paused');
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /paused/);
  rmSync(dir, { recursive: true });
});

// ── Gate 2: daily spend ───────────────────────────────────────────────────────

test('gate 2 fails when daily spend meets ceiling → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  db.prepare('INSERT INTO usage_daily (day, cost_usd) VALUES (?, ?)').run('2026-09-05', 15.0);

  const result = checkDailySpend(db, 15.0, '2026-09-05');
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /ceiling/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /ceiling/);

  rmSync(dir, { recursive: true });
});

test('gate 2 passes when spend is below ceiling', () => {
  const { db, dir } = makeDb();
  db.prepare('INSERT INTO usage_daily (day, cost_usd) VALUES (?, ?)').run('2026-09-05', 5.0);
  const result = checkDailySpend(db, 15.0, '2026-09-05');
  assert.equal(result.ok, true);
  rmSync(dir, { recursive: true });
});

test('two live sessions reserve budget, blocking spawn at daily ceiling', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);

  // $12 spent today
  db.prepare('INSERT INTO usage_daily (day, cost_usd) VALUES (?, ?)').run('2026-09-26', 12.0);
  // 2 live sessions × $1.5/session = $3 reserved → total $15 meets $15 ceiling
  db.prepare(
    `INSERT INTO sessions (id, agent_id, tier, harness, status)
     VALUES ('s1', 'lantern', 'read_only', 'claude-code', 'running')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, tier, harness, status)
     VALUES ('s2', 'lantern', 'read_only', 'claude-code', 'running')`,
  ).run();

  const result = checkDailySpend(db, 15.0, '2026-09-26', 'lantern');
  assert.equal(result.ok, false);
  const reason = (result as { ok: false; reason: string }).reason;
  assert.match(reason, /reserved/);
  assert.match(reason, /ceiling/);

  // Without agentId, no reservation: $12 spent < $15 → pass
  const noReserve = checkDailySpend(db, 15.0, '2026-09-26');
  assert.equal(noReserve.ok, true);

  rmSync(dir, { recursive: true });
});

// ── Gate 3: live children ─────────────────────────────────────────────────────

test('gate 3 fails when live children meets max_children → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  db.prepare(
    `INSERT INTO sessions (id, agent_id, tier, harness, status)
     VALUES ('s1', 'lantern', 'read_only', 'claude-code', 'running')`,
  ).run();

  const result = checkLiveChildren(db, 'lantern', 1);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /max_children/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /max_children/);

  rmSync(dir, { recursive: true });
});

// ── Gate 4: quiet hours ───────────────────────────────────────────────────────

test('gate 4 passes with no quiet hours configured', () => {
  const result = checkQuietHours([]);
  assert.equal(result.ok, true);
});

test('gate 4 fails during configured quiet hours → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  const quietTime = new Date('2026-09-05T22:30:00');

  const result = checkQuietHours([['22:00', '07:00']], quietTime);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /quiet hours/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /quiet hours/);

  rmSync(dir, { recursive: true });
});

test('gate 4 passes just outside quiet window', () => {
  const morning = new Date('2026-09-05T07:01:00');
  const result = checkQuietHours([['22:00', '07:00']], morning);
  assert.equal(result.ok, true);
});

// ── Gate 5: working tree ──────────────────────────────────────────────────────

test('gate 5 fails when working tree is dirty → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);

  const result = checkWorkingTree('/workdir', false, () => 'M  src/foo.ts\n');
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /dirty/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /dirty/);

  rmSync(dir, { recursive: true });
});

test('gate 5 passes when allow_dirty is true regardless of tree state', () => {
  const result = checkWorkingTree('/workdir', true, () => 'M  src/foo.ts\n');
  assert.equal(result.ok, true);
});

test('gate 5 passes when working tree is clean', () => {
  const result = checkWorkingTree('/workdir', false, () => '');
  assert.equal(result.ok, true);
});

// ── Gate 6: no pulse running ──────────────────────────────────────────────────

test('gate 6 fails when a pulse is already running → skipped pulse', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  createRunningPulse(db, {
    agentId: 'lantern',
    windowStart: '2026-09-05T00:00:00.000Z',
    windowEnd: '2026-09-05T01:00:00.000Z',
  });

  const result = checkNoPulseRunning(db, 'lantern');
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /running/);

  const now = new Date().toISOString();
  const id = createSkippedPulse(db, {
    agentId: 'lantern',
    windowStart: now,
    windowEnd: now,
    reason: (result as { ok: false; reason: string }).reason,
  });
  const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(id) as {
    status: string;
    error: string;
  };
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /running/);

  rmSync(dir, { recursive: true });
});

// ── runGates: combined ────────────────────────────────────────────────────────

test('runGates passes when all gates clear', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);

  const result = runGates(db, {
    lanternDir: dir,
    agentId: 'lantern',
    agentState: 'running',
    agentWorkdir: dir,
    agentMaxChildren: 4,
    allowDirty: true,
    quietHours: [],
  });
  assert.equal(result.ok, true);

  rmSync(dir, { recursive: true });
});

test('runGates stops at first failure', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  writeFileSync(join(dir, 'PAUSED'), '');

  const result = runGates(db, {
    lanternDir: dir,
    agentId: 'lantern',
    agentState: 'running',
    agentWorkdir: dir,
    agentMaxChildren: 4,
    allowDirty: true,
  });
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; reason: string }).reason, /PAUSED/);

  rmSync(dir, { recursive: true });
});

// queued sessions are neither live children nor spending. Counting them
// let a queue of 20 hold gate 3 and reserve $27 against gate 2 — every pulse
// skipped, and reap (which runs after a pulse) never drained the queue.
test('gates 2 and 3 do not count queued (starting) sessions', () => {
  const { db, dir } = makeDb();
  ensureDefaultAgent(db, dir);
  for (let i = 0; i < 20; i++) {
    db.prepare(
      `INSERT INTO sessions (id, agent_id, tier, status) VALUES (?, 'lantern', 'read_only', 'starting')`,
    ).run(`q${i}`);
  }
  assert.equal(checkLiveChildren(db, 'lantern', 1).ok, true);
  assert.equal(checkDailySpend(db, 15.0, '2026-09-26', 'lantern').ok, true);
  rmSync(dir, { recursive: true });
});
