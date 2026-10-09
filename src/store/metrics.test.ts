import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { computeMetrics } from './metrics.ts';
import { createRunningPulse, finishPulse, writePulseFinding } from './pulses.ts';
import { closeTicket, createTicket } from './tickets.ts';
import { recordDailyUsage } from './usage.ts';

const NOW = new Date('2026-10-10T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-metrics-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, dir);
  db.prepare('UPDATE agents SET heartbeat_seconds = 900 WHERE id = ?').run(agent.id); // 15 min
  const pulseAt = (h: number, findings: Array<[string, string]> = []) => {
    const id = createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' });
    for (const [key, outcome] of findings) {
      writePulseFinding(db, { pulseId: id, actionKey: key, outcome: outcome as 'clean' });
    }
    finishPulse(db, id, { status: 'clean' });
    db.prepare('UPDATE pulses SET started_at = ?, ended_at = ? WHERE id = ?').run(at(h), at(h), id);
    return id;
  };
  const ticket = (origin: string, createdH: number) => {
    const id = createTicket(
      db,
      { kind: 'bug', title: `t${createdH}`, body: 'b', origin: origin as 'human' },
      { actor: 'collector' },
    );
    db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(at(createdH), id);
    return id;
  };
  const close = (id: number, status: 'closed' | 'wontfix', closedH: number) => {
    closeTicket(db, id, { status, resolution: 'r' }, { actor: 'human' });
    db.prepare('UPDATE tickets SET closed_at = ? WHERE id = ?').run(at(closedH), id);
  };
  return { db, agent, pulseAt, ticket, close, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('metrics: pulses run vs. scheduled — a long gap is downtime, not missed pulses', () => {
  const w = world();
  try {
    // 15-min heartbeat. Pulses at -10h, -9.75h, -9.5h, then -8.75h (a 45-min gap: 2 missed),
    // then nothing for 6 h (> 6× heartbeat: the daemon was down), then -2.75h, -2.5h.
    for (const h of [10, 9.75, 9.5, 8.75, 2.75, 2.5]) w.pulseAt(h);
    const m = computeMetrics(w.db, { days: 30, now: NOW });
    assert.equal(m.pulses.run, 6);
    assert.equal(m.pulses.scheduled, 8, '1 + 1 + 1 + 3 + 1 (after downtime) + 1');
    assert.equal(m.pulses.missed, 2);
    assert.equal(m.pulses.rate?.toFixed(3), (6 / 8).toFixed(3));
    assert.equal(m.pulses.downtimeHours.toFixed(2), '6.00');
  } finally {
    w.cleanup();
  }
});

test('metrics: findings per pulse by collector, and precision per collector in the window', () => {
  const w = world();
  try {
    w.pulseAt(3, [
      ['logs.scan', 'finding'],
      ['inbox.bugs', 'clean'],
    ]);
    w.pulseAt(2, [
      ['logs.scan', 'finding'],
      ['inbox.bugs', 'finding'],
    ]);
    w.pulseAt(1, [
      ['logs.scan', 'clean'],
      ['inbox.bugs', 'clean'],
    ]);
    w.pulseAt(24 * 40, [['logs.scan', 'finding']]); // outside a 30-day window
    const m = computeMetrics(w.db, { days: 30, now: NOW });
    const f = Object.fromEntries(m.findings.map((r) => [r.actionKey, r]));
    assert.equal(f['logs.scan']?.findings, 2);
    assert.equal(f['logs.scan']?.perPulse.toFixed(3), (2 / 3).toFixed(3));
    assert.equal(f['inbox.bugs']?.findings, 1);

    const a = w.ticket('collector:logs', 5);
    w.ticket('collector:logs', 4);
    w.ticket('collector:logs', 3);
    w.close(a, 'wontfix', 1);
    const old = w.ticket('collector:logs', 24 * 40);
    w.close(old, 'wontfix', 24 * 39);
    const p = computeMetrics(w.db, { days: 30, now: NOW }).precision;
    assert.deepEqual(
      p.map((r) => [r.collector, r.filed, r.noise]),
      [['collector:logs', 3, 1]],
    );
  } finally {
    w.cleanup();
  }
});

test('metrics: observation → ticket → close times, human touches, cost per closed ticket', () => {
  const w = world();
  try {
    // Observed 10 h before it was ticketed; ticketed at -20h, closed at -8h (12 h).
    const a = w.ticket('collector:logs', 20);
    w.db.prepare('UPDATE tickets SET fingerprint = ? WHERE id = ?').run('fp-a', a);
    w.db
      .prepare(
        // As the collectors write it: linked by fingerprint, ticket_id left empty.
        `INSERT INTO observations (fingerprint, source, sample, first_seen) VALUES ('fp-a', 'logs', 's', ?)`,
      )
      .run(at(30));
    w.close(a, 'closed', 8);
    // Second, human-filed: no observation; ticketed -10h, closed -6h (4 h).
    const b = w.ticket('human', 10);
    w.db
      .prepare(
        `INSERT INTO ticket_events (ticket_id, actor, event) VALUES (?, 'human', 'commented')`,
      )
      .run(b);
    w.close(b, 'closed', 6);
    // A dismissal: closed, but not fixed — counts for touches, not for cost or time-to-close.
    const c = w.ticket('collector:logs', 5);
    w.close(c, 'wontfix', 4);

    recordDailyUsage(w.db, { day: '2026-10-10', costUsd: 3 });
    recordDailyUsage(w.db, { day: '2026-10-09', costUsd: 1 });
    recordDailyUsage(w.db, { day: '2026-08-01', costUsd: 100 }); // outside the window

    const m = computeMetrics(w.db, { days: 30, now: NOW });
    assert.equal(m.observationToTicketHours.n, 1);
    assert.equal(m.observationToTicketHours.mean?.toFixed(1), '10.0');
    assert.equal(m.ticketToCloseHours.n, 2);
    assert.equal(m.ticketToCloseHours.mean?.toFixed(1), '8.0', '(12 + 4) / 2');
    // a: close (human) = 1 · b: comment + close = 2 · c: close = 1 → 4 / 3
    assert.equal(m.humanTouches.closed, 3);
    assert.equal(m.humanTouches.mean?.toFixed(3), (4 / 3).toFixed(3));
    assert.equal(m.cost.spendUsd, 4);
    assert.equal(m.cost.closed, 2);
    assert.equal(m.cost.perClosedUsd, 2);
  } finally {
    w.cleanup();
  }
});

test('metrics: an empty store gives zeros and nulls, never NaN', () => {
  const w = world();
  try {
    const m = computeMetrics(w.db, { days: 30, now: NOW });
    assert.equal(m.pulses.rate, null);
    assert.equal(m.ticketToCloseHours.mean, null);
    assert.equal(m.cost.perClosedUsd, null);
    assert.ok(!JSON.stringify(m).includes('NaN'));
  } finally {
    w.cleanup();
  }
});

test('metrics: closures and noise say who decided — a human or the agent', () => {
  const w = world();
  try {
    const a = w.ticket('collector:logs', 5);
    const b = w.ticket('collector:logs', 4);
    const c = w.ticket('collector:logs', 3);
    closeTicket(w.db, a, { status: 'wontfix', resolution: 'demo error' }, { actor: 'petclinic' });
    closeTicket(w.db, b, { status: 'wontfix', resolution: 'noise' }, { actor: 'human' });
    closeTicket(w.db, c, { status: 'duplicate', resolution: 'same as #1' }, { actor: 'petclinic' });
    for (const id of [a, b, c])
      w.db.prepare('UPDATE tickets SET closed_at = ? WHERE id = ?').run(at(1), id);
    const m = computeMetrics(w.db, { days: 30, now: NOW });
    assert.equal(m.humanTouches.closed, 3);
    assert.equal(m.humanTouches.closedByHuman, 1);
    assert.equal(m.humanTouches.closedByAgent, 2);
    const logs = m.precision.find((p) => p.collector === 'collector:logs');
    assert.equal(logs?.noise, 2);
    assert.equal(logs?.noiseByHuman, 1);
  } finally {
    w.cleanup();
  }
});

// ── precision has one implementation — these cases came from the
//    retired store/collector-precision.ts ─────────────────────────────────────

test('metrics precision: none filed → no rows; human tickets are not a collector; 3 → 100%, 4 with 2 wontfix → 50%', () => {
  const w = world();
  try {
    assert.deepEqual(computeMetrics(w.db, { days: 30, now: NOW }).precision, []);
    w.ticket('human', 2);
    assert.deepEqual(computeMetrics(w.db, { days: 30, now: NOW }).precision, [], 'human excluded');
    for (const h of [5, 4, 3]) w.ticket('collector:email', h);
    const email = computeMetrics(w.db, { days: 30, now: NOW }).precision[0];
    assert.deepEqual(
      [email?.collector, email?.filed, email?.noise, email?.precision],
      ['collector:email', 3, 0, 1],
    );
    const logs = [6, 5, 4, 3].map((h) => w.ticket('collector:logs', h));
    w.close(logs[0] as number, 'wontfix', 1);
    w.close(logs[1] as number, 'wontfix', 1);
    const l = computeMetrics(w.db, { days: 30, now: NOW }).precision.find(
      (p) => p.collector === 'collector:logs',
    );
    assert.equal(l?.precision, 0.5);
  } finally {
    w.cleanup();
  }
});
