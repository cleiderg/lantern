import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from './agent.ts';
import { loadAgentConfig } from './agent-config.ts';
import { openDb } from './db.ts';
import { buildDigest } from './digest.ts';
import { runMigrations } from './migrate.ts';
import { createRunningPulse, finishPulse } from './store/pulses.ts';
import { createTicket } from './store/tickets.ts';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-digest-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { db, dir, agent };
}

const now = new Date('2026-09-05T10:00:00Z');
const window = {
  window_start: '2026-09-05T09:00:00.000Z',
  window_end: '2026-09-05T10:00:00.000Z',
};

test('digest renders correctly on empty DB', () => {
  const { db, dir, agent } = makeDb();

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /# Pulse Digest — Lantern/);
  assert.match(digest, /\*\*Window:\*\* 2026-09-05T09:00:00Z → 2026-09-05T10:00:00Z/);
  assert.match(digest, /\*\*Budget remaining today:\*\* \$15\.00 of \$15\.00/);
  assert.match(digest, /## Mission/);
  assert.match(digest, /Watch the system/);
  assert.match(digest, /## Open Tickets \(0\)/);
  assert.match(digest, /_No open tickets\./);
  assert.match(digest, /## Live Sessions \(0\)/);
  assert.match(digest, /## Last 5 Pulse Summaries/);
  assert.match(digest, /_No prior pulses\./);
  assert.match(digest, /## Unanswered Escalations \(0\)/);
  assert.match(digest, /_None\./);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows open tickets oldest p0-first, capped at 40', () => {
  const { db, dir, agent } = makeDb();
  const ctx = { actor: 'test' };

  createTicket(
    db,
    { kind: 'bug', title: 'P3 old ticket', body: 'b', origin: 'human', priority: 'p3' },
    ctx,
  );
  createTicket(
    db,
    { kind: 'bug', title: 'P0 urgent', body: 'b', origin: 'human', priority: 'p0' },
    ctx,
  );
  createTicket(
    db,
    { kind: 'bug', title: 'P1 medium', body: 'b', origin: 'human', priority: 'p1' },
    ctx,
  );

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /## Open Tickets \(3\)/);
  const p0Pos = digest.indexOf('P0 urgent');
  const p1Pos = digest.indexOf('P1 medium');
  const p3Pos = digest.indexOf('P3 old ticket');
  assert.ok(p0Pos < p1Pos, 'p0 before p1');
  assert.ok(p1Pos < p3Pos, 'p1 before p3');

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows closed tickets are excluded', () => {
  const { db, dir, agent } = makeDb();
  const ctx = { actor: 'test' };

  const id = createTicket(
    db,
    { kind: 'bug', title: 'Closed bug', body: 'b', origin: 'human' },
    ctx,
  );
  db.prepare(
    `UPDATE tickets SET status = 'closed', resolution = 'fixed', closed_at = datetime('now') WHERE id = ?`,
  ).run(id);

  const digest = buildDigest(db, agent, window, 15.0, now);
  assert.match(digest, /## Open Tickets \(0\)/);
  assert.doesNotMatch(digest, /Closed bug/);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows live sessions', () => {
  const { db, dir, agent } = makeDb();

  db.prepare(
    `INSERT INTO sessions (id, agent_id, tier, harness, status, label)
     VALUES ('sess-abc', 'lantern', 'read_only', 'claude-code', 'running', 'investigate-auth')`,
  ).run();

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /## Live Sessions \(1\)/);
  assert.match(digest, /investigate-auth/);
  assert.match(digest, /read_only/);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows last 5 pulse summaries, excludes running/skipped', () => {
  const { db, dir, agent } = makeDb();

  for (let i = 0; i < 7; i++) {
    const pid = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: `2026-09-05T0${i}:00:00.000Z`,
      windowEnd: `2026-09-05T0${i}:59:00.000Z`,
    });
    finishPulse(db, pid, { status: 'clean', summary: `All clear pulse ${i}` });
  }

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /## Last 5 Pulse Summaries/);
  const matches = [...digest.matchAll(/All clear pulse/g)];
  assert.equal(matches.length, 5);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows unanswered escalations', () => {
  const { db, dir, agent } = makeDb();

  db.prepare(
    `INSERT INTO escalations (agent_id, severity, question)
     VALUES ('lantern', 'decide', 'Should we close ticket #5?')`,
  ).run();

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /## Unanswered Escalations \(1\)/);
  assert.match(digest, /\[DECIDE\]/);
  assert.match(digest, /Should we close ticket #5\?/);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest reflects spent budget', () => {
  const { db, dir, agent } = makeDb();

  db.prepare(`INSERT INTO usage_daily (day, cost_usd) VALUES ('2026-09-05', 7.50)`).run();

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /\*\*Budget remaining today:\*\* \$7\.50 of \$15\.00/);

  db.close();
  rmSync(dir, { recursive: true });
});

test('digest shows "N of total" when total exceeds cap', () => {
  const { db, dir, agent } = makeDb();
  const ctx = { actor: 'test' };

  for (let i = 0; i < 42; i++) {
    createTicket(db, { kind: 'bug', title: `ticket ${i}`, body: 'b', origin: 'human' }, ctx);
  }

  const digest = buildDigest(db, agent, window, 15.0, now);

  assert.match(digest, /## Open Tickets \(40 of 42, oldest p0-first\)/);

  db.close();
  rmSync(dir, { recursive: true });
});

// ── the digest carries the agent config ────────────────────────────────

test('buildDigest: with a config, carries its expertise, laws and numbered actions with keys', () => {
  const { db, dir, agent } = makeDb();
  try {
    const config = loadAgentConfig(
      fileURLToPath(new URL('../test/fixtures/agents/lloyd.agent.md', import.meta.url)),
    );
    const d = buildDigest(db, agent, window, 4, now, config);
    assert.match(d, /## Expertise\n\nEngineering manager for this codebase\./);
    assert.match(d, /## Laws\n\n- Never push to main; never force-push\./);
    assert.match(
      d,
      /## Every-pulse Actions\n1\. `inbox\.bugs` — playbook inbox\.bugs\n2\. `logs\.scan` — playbook logs\.scan/,
    );
    assert.match(
      d,
      /1\. Run `inbox\.bugs`\./,
      "the body's own action instructions follow the keyed list",
    );
    assert.match(d, /Budget remaining today:\*\* \$4\.00 of \$4\.00/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildDigest: without a config, keeps the built-in heartbeat.selfcheck action', () => {
  const { db, dir, agent } = makeDb();
  try {
    const d = buildDigest(db, agent, window, 15.0, now);
    assert.match(d, /## Every-pulse Actions\n1\. `heartbeat\.selfcheck`/);
    assert.doesNotMatch(d, /## Expertise/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── two agents side by side: each digest shows its own tickets ────────────────

test('buildDigest: open tickets are the agent own plus unowned ones, never another agent', () => {
  const { db, dir, agent } = makeDb();
  try {
    db.prepare(
      `INSERT INTO agents (id, display_name, config_path, mission, workdir) VALUES ('other', 'Other', 'x', 'm', ?)`,
    ).run(dir);
    const mk = (title: string, agentId: string | null) =>
      createTicket(
        db,
        { kind: 'bug', title, body: 'b', origin: 'agent:self', agent_id: agentId },
        { actor: 't' },
      );
    mk('Mine to handle', agent.id);
    mk('Filed by a human', null);
    mk('The other agent owns this', 'other');
    const d = buildDigest(db, agent, window, 15.0, now);
    assert.match(d, /Mine to handle/);
    assert.match(d, /Filed by a human/);
    assert.doesNotMatch(d, /The other agent owns this/);
    assert.match(d, /## Open Tickets \(2\)/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
