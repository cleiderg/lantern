/**
 * 24h soak test at 15-min heartbeat using FakeHarness.
 *
 * Simulates 96 consecutive pulses (24h / 15min = 96) without any real model calls.
 * Verifies: every pulse completes (no stuck 'running' rows), windows are
 * contiguous (no gaps), and each pulse has ≥1 pulse_findings row.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeHarness } from '../test/support/fake-harness.ts';
import { ensureDefaultAgent } from './agent.ts';
import { openDb } from './db.ts';
import { buildDigest } from './digest.ts';
import { runOrchestratorTurn } from './harness/orchestrator.ts';
import { runMigrations } from './migrate.ts';
import { computeWindow } from './scheduler.ts';
import { createRunningPulse, getPulseFindings } from './store/pulses.ts';
import type { Pulse } from './types.ts';

const HEARTBEAT_MINUTES = 15;
const SOAK_HOURS = 24;
const EXPECTED_PULSES = (SOAK_HOURS * 60) / HEARTBEAT_MINUTES; // 96

test(`24h soak: ${EXPECTED_PULSES} pulses at ${HEARTBEAT_MINUTES}-min heartbeat, zero gaps, all findings written`, {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-soak-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);

  // Simulate 24h starting from a fixed epoch
  const epochMs = new Date('2026-09-07T00:00:00.000Z').getTime();
  const heartbeatMs = HEARTBEAT_MINUTES * 60 * 1000;
  let lastWindowEnd: string | null = null;

  for (let i = 0; i < EXPECTED_PULSES; i++) {
    const nowMs = epochMs + i * heartbeatMs + heartbeatMs; // end of this tick
    const nowIso = new Date(nowMs).toISOString();

    const window = computeWindow(lastWindowEnd, nowIso);
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: window.window_start,
      windowEnd: window.window_end,
    });

    const digest = buildDigest(db, agent, window);
    const harness = new FakeHarness({ result: 'heartbeat.selfcheck: daemon healthy', costUsd: 0 });

    await runOrchestratorTurn({ db, agent, pulseId, digest, lanternDir: dir, harness });

    lastWindowEnd = window.window_end;
  }

  // ── Assertions ────────────────────────────────────────────────────────────

  const pulses = db
    .prepare(`SELECT * FROM pulses WHERE agent_id = ? ORDER BY id`)
    .all(agent.id) as Pulse[];

  assert.equal(pulses.length, EXPECTED_PULSES, `expected ${EXPECTED_PULSES} pulse rows`);

  let prevWindowEnd: string | null = null;
  for (const [i, p] of pulses.entries()) {
    // No stuck 'running' rows
    assert.notEqual(p.status, 'running', `pulse #${p.id} (tick ${i + 1}) must not be 'running'`);

    // Contiguous windows — each window_start equals the previous window_end
    if (prevWindowEnd !== null) {
      assert.equal(
        p.window_start,
        prevWindowEnd,
        `pulse #${p.id} (tick ${i + 1}): window_start should continue from previous window_end`,
      );
    }
    prevWindowEnd = p.window_end;

    // Every pulse must have ≥1 finding
    const findings = getPulseFindings(db, p.id);
    assert.ok(
      findings.length >= 1,
      `pulse #${p.id} (tick ${i + 1}) must have ≥1 pulse_findings row`,
    );
  }

  db.close();
  rmSync(dir, { recursive: true });
});
