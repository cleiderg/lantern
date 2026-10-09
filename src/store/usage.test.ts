import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent, getAgent, setAgentState } from '../agent.ts';
import { DEFAULT_DAILY_CEILING_USD } from '../budget.ts';
import { openDb } from '../db.ts';
import { runGates } from '../gates.ts';
import { runMigrations } from '../migrate.ts';
import { createRunningPulse, createSkippedPulse, finishPulse } from './pulses.ts';
import {
  enforceDailyCeiling,
  getDailySpend,
  getDailyUsage,
  recordDailyUsage,
  utcDay,
} from './usage.ts';

const DAY = '2026-09-27';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-usage-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  setAgentState(db, agent.id, 'running');
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

function newPulse(db: ReturnType<typeof openDb>, agentId: string): number {
  return createRunningPulse(db, {
    agentId,
    windowStart: `${DAY}T00:00:00.000Z`,
    windowEnd: `${DAY}T01:00:00.000Z`,
  });
}

// ─── utcDay ───────────────────────────────────────────────────────────────────

test('utcDay keys by UTC, not host local time', () => {
  // 03:23Z on the 27th is still the 26th in any negative-offset zone. The key
  // must not depend on where the host is.
  assert.equal(utcDay(new Date('2026-09-27T03:23:15.379Z')), '2026-09-27');
  assert.equal(utcDay(new Date('2026-09-27T00:00:00.000Z')), '2026-09-27');
  assert.equal(utcDay(new Date('2026-09-26T23:59:59.999Z')), '2026-09-26');
});

// ─── recordDailyUsage ─────────────────────────────────────────────────────────

test('getDailyUsage: a day with no activity reads as zeros, not absent', () => {
  const { db, cleanup } = setup();
  try {
    assert.deepEqual(getDailyUsage(db, DAY), { day: DAY, cost_usd: 0, pulses: 0, sessions: 0 });
    assert.equal(getDailySpend(db, DAY), 0);
  } finally {
    cleanup();
  }
});

test('recordDailyUsage: inserts, then accumulates instead of replacing', () => {
  const { db, cleanup } = setup();
  try {
    const first = recordDailyUsage(db, { day: DAY, costUsd: 0.1207, pulses: 1 });
    assert.equal(first.pulses, 1);
    assert.ok(Math.abs(first.cost_usd - 0.1207) < 1e-9);

    const second = recordDailyUsage(db, { day: DAY, costUsd: 0.25, pulses: 1 });
    assert.equal(second.pulses, 2, 'second pulse must add to the day, not overwrite it');
    assert.ok(Math.abs(second.cost_usd - 0.3707) < 1e-9);

    const withSession = recordDailyUsage(db, { day: DAY, costUsd: 1.0, sessions: 1 });
    assert.equal(withSession.sessions, 1);
    assert.equal(withSession.pulses, 2, 'session cost must not disturb the pulse count');
  } finally {
    cleanup();
  }
});

test('recordDailyUsage: separate days keep separate rows', () => {
  const { db, cleanup } = setup();
  try {
    recordDailyUsage(db, { day: '2026-09-26', costUsd: 5, pulses: 1 });
    recordDailyUsage(db, { day: '2026-09-27', costUsd: 2, pulses: 1 });
    assert.equal(getDailySpend(db, '2026-09-26'), 5);
    assert.equal(getDailySpend(db, '2026-09-27'), 2);
  } finally {
    cleanup();
  }
});

// ─── Close a pulse, THEN assert on the rollup ───

test('finishPulse rolls its cost into usage_daily (regression)', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = newPulse(db, agent.id);
    finishPulse(db, id, { status: 'clean', costUsd: 0.1207, summary: 'ok', day: DAY });

    const usage = getDailyUsage(db, DAY);
    assert.ok(
      Math.abs(usage.cost_usd - 0.1207) < 1e-9,
      `pulse cost must reach usage_daily, got ${usage.cost_usd}`,
    );
    assert.equal(usage.pulses, 1);
  } finally {
    cleanup();
  }
});

test('finishPulse: two pulses accumulate into one day', () => {
  const { db, agent, cleanup } = setup();
  try {
    finishPulse(db, newPulse(db, agent.id), { status: 'clean', costUsd: 0.1, day: DAY });
    finishPulse(db, newPulse(db, agent.id), { status: 'acted', costUsd: 0.4, day: DAY });
    const usage = getDailyUsage(db, DAY);
    assert.equal(usage.pulses, 2);
    assert.ok(Math.abs(usage.cost_usd - 0.5) < 1e-9);
  } finally {
    cleanup();
  }
});

test('finishPulse: a zero-cost pulse still counts as a pulse', () => {
  const { db, agent, cleanup } = setup();
  try {
    finishPulse(db, newPulse(db, agent.id), { status: 'skipped', day: DAY });
    const usage = getDailyUsage(db, DAY);
    assert.equal(usage.pulses, 1, 'coverage is proven by the pulse count, not by its cost');
    assert.equal(usage.cost_usd, 0);
  } finally {
    cleanup();
  }
});

// ─── Law 7 — breach trips the agent ───────────────────────────────────────────

test('enforceDailyCeiling: below the ceiling changes nothing', () => {
  const { db, agent, cleanup } = setup();
  try {
    recordDailyUsage(db, { day: DAY, costUsd: 1.0 });
    assert.equal(enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }), false);
    assert.equal(getAgent(db, agent.id)?.state, 'running');
  } finally {
    cleanup();
  }
});

test('enforceDailyCeiling: breach sets state=tripped with a reason (Law 7)', () => {
  const { db, agent, cleanup } = setup();
  try {
    recordDailyUsage(db, { day: DAY, costUsd: 15.5 });
    assert.equal(enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }), true);
    const tripped = getAgent(db, agent.id);
    assert.equal(tripped?.state, 'tripped');
    assert.match(String(tripped?.paused_reason), /daily budget breached/);
    assert.match(String(tripped?.paused_reason), /lantern resume/);
  } finally {
    cleanup();
  }
});

test('enforceDailyCeiling: exactly at the ceiling trips (>=, not >)', () => {
  const { db, agent, cleanup } = setup();
  try {
    recordDailyUsage(db, { day: DAY, costUsd: 15 });
    assert.equal(enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }), true);
    assert.equal(getAgent(db, agent.id)?.state, 'tripped');
  } finally {
    cleanup();
  }
});

test('enforceDailyCeiling: reports the transition once, not on every call', () => {
  const { db, agent, cleanup } = setup();
  try {
    recordDailyUsage(db, { day: DAY, costUsd: 20 });
    assert.equal(enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }), true);
    assert.equal(
      enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }),
      false,
      'already tripped — the caller should not re-announce it',
    );
  } finally {
    cleanup();
  }
});

test('enforceDailyCeiling: does not overwrite an operator-chosen paused state', () => {
  const { db, agent, cleanup } = setup();
  try {
    setAgentState(db, agent.id, 'paused', 'operator ran lantern pause');
    recordDailyUsage(db, { day: DAY, costUsd: 20 });
    assert.equal(enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: 15, day: DAY }), false);
    const still = getAgent(db, agent.id);
    assert.equal(still?.state, 'paused');
    assert.equal(still?.paused_reason, 'operator ran lantern pause');
  } finally {
    cleanup();
  }
});

test('finishPulse trips the agent when its own cost breaches the ceiling', () => {
  const { db, agent, cleanup } = setup();
  try {
    finishPulse(db, newPulse(db, agent.id), {
      status: 'acted',
      costUsd: 20,
      day: DAY,
      dailyCeilingUsd: 15,
    });
    assert.equal(getAgent(db, agent.id)?.state, 'tripped', 'Law 7 applies at pulse close');
  } finally {
    cleanup();
  }
});

// ─── Gate 2 is reachable now ───────────────────────────────────────────────────

test('gate 2 refuses a pulse once real recorded spend meets the ceiling', () => {
  const { dir, db, agent, cleanup } = setup();
  try {
    // Before: the gate passes.
    const before = runGates(db, {
      lanternDir: dir,
      agentId: agent.id,
      agentState: 'running',
      agentWorkdir: dir,
      agentMaxChildren: 4,
      dailyCeilingUsd: 15,
      allowDirty: true,
      day: DAY,
    });
    assert.equal(before.ok, true);

    // A real pulse close is what moves the needle — no direct usage_daily seeding.
    finishPulse(db, newPulse(db, agent.id), {
      status: 'acted',
      costUsd: 16,
      day: DAY,
      dailyCeilingUsd: 15,
    });

    const after = runGates(db, {
      lanternDir: dir,
      agentId: agent.id,
      agentState: 'running',
      agentWorkdir: dir,
      agentMaxChildren: 4,
      dailyCeilingUsd: 15,
      allowDirty: true,
      day: DAY,
    });
    assert.equal(after.ok, false);
    assert.match(String(!after.ok && after.reason), /daily spend \$16\.00.*ceiling \$15\.00/);
  } finally {
    cleanup();
  }
});

test('gate 1 refuses a tripped agent, so the trip actually stops the loop', () => {
  const { dir, db, agent, cleanup } = setup();
  try {
    finishPulse(db, newPulse(db, agent.id), {
      status: 'acted',
      costUsd: 20,
      day: DAY,
      dailyCeilingUsd: 15,
    });
    const state = getAgent(db, agent.id)?.state ?? 'running';
    const result = runGates(db, {
      lanternDir: dir,
      agentId: agent.id,
      agentState: state,
      agentWorkdir: dir,
      agentMaxChildren: 4,
      allowDirty: true,
      day: DAY,
    });
    assert.equal(result.ok, false);
    assert.match(String(!result.ok && result.reason), /agent state is 'tripped'/);
  } finally {
    cleanup();
  }
});

test('the default ceiling is one shared constant', () => {
  assert.equal(DEFAULT_DAILY_CEILING_USD, 15.0);
});

// ─── agents.last_pulse_at — the `last_pulse=never` bug ────────────────────────

test('createRunningPulse stamps agents.last_pulse_at', () => {
  const { db, agent, cleanup } = setup();
  try {
    assert.equal(getAgent(db, agent.id)?.last_pulse_at, null, 'starts unstamped');
    newPulse(db, agent.id);
    const stamped = getAgent(db, agent.id)?.last_pulse_at;
    assert.ok(stamped, 'a started pulse must stamp the agent — the dead-man alert reads this');
    assert.match(String(stamped), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test('createSkippedPulse stamps it too — a gated pulse still proves liveness', () => {
  const { db, agent, cleanup } = setup();
  try {
    createSkippedPulse(db, {
      agentId: agent.id,
      windowStart: `${DAY}T00:00:00.000Z`,
      windowEnd: `${DAY}T01:00:00.000Z`,
      reason: 'quiet hours active',
    });
    assert.ok(getAgent(db, agent.id)?.last_pulse_at, 'skipped is still a pulse the loop recorded');
  } finally {
    cleanup();
  }
});

test('a later pulse advances the stamp', () => {
  const { db, agent, cleanup } = setup();
  try {
    newPulse(db, agent.id);
    const first = getAgent(db, agent.id)?.last_pulse_at;
    // Move the clock forward by writing a second pulse a moment later.
    const id = newPulse(db, agent.id);
    finishPulse(db, id, { status: 'clean', costUsd: 0, day: DAY });
    const second = getAgent(db, agent.id)?.last_pulse_at;
    assert.ok(String(second) >= String(first), 'stamp must not go backwards');
  } finally {
    cleanup();
  }
});

test('pulse creation does not invent a next_pulse_at', () => {
  const { db, agent, cleanup } = setup();
  try {
    newPulse(db, agent.id);
    assert.equal(
      getAgent(db, agent.id)?.next_pulse_at,
      null,
      'only the daemon scheduler knows the next tick; a manual pulse must not advertise one',
    );
  } finally {
    cleanup();
  }
});
