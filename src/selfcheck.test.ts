import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { openDb } from './db.ts';
import { runMigrations } from './migrate.ts';
import { runHeartbeatSelfcheck } from './selfcheck.ts';
import { createRunningPulse, getPulseFindings } from './store/pulses.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-selfcheck-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('runHeartbeatSelfcheck: healthy=true and writes a clean finding for a live running pulse', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-29T00:00:00.000Z',
      windowEnd: '2026-09-29T01:00:00.000Z',
    });

    const result = runHeartbeatSelfcheck(db, pulseId);
    assert.equal(result.healthy, true);
    assert.deepEqual(result.problems, []);

    const findings = getPulseFindings(db, pulseId);
    const finding = findings.find((f) => f.action_key === 'heartbeat.selfcheck');
    assert.ok(finding, 'must write a heartbeat.selfcheck finding');
    assert.equal(finding.outcome, 'clean');
  } finally {
    cleanup();
  }
});

test('runHeartbeatSelfcheck: unhealthy for a pulse that is not status=running', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-29T00:00:00.000Z',
      windowEnd: '2026-09-29T01:00:00.000Z',
    });
    db.prepare(`UPDATE pulses SET status = 'error' WHERE id = ?`).run(pulseId);

    const result = runHeartbeatSelfcheck(db, pulseId);
    assert.equal(result.healthy, false);
    assert.match(result.problems.join(';'), /expected 'running'/);
  } finally {
    cleanup();
  }
});
