/**
 * Week-replay acceptance test.
 *
 * Replays a captured week of logs using the week-replay-logs.ndjson fixture:
 *   - Real issue: "Worker crashed: memory overflow" (Fault) — every day
 *   - Noisy pattern: "Cache miss for key: ..." (Default/info) — day 1 only
 *
 * Verifies:
 *   1. Known real issue is ticketed (Fault → immediate threshold on pulse 1).
 *   2. Known noisy pattern is NOT ticketed (info, pulse_count stays at 1).
 *   3. Precision on the sample ≥ 70%.
 *   4. Suppression survives a daemon restart (close + reopen DB).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { computeMetrics } from '../store/metrics.ts';
import { suppressFingerprint } from '../store/observations.ts';
import { createRunningPulse } from '../store/pulses.ts';
import { closeTicket, listTickets } from '../store/tickets.ts';
import { FileLogSource, scanLogs } from './logs-scan.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures', import.meta.url));
const WEEK_FIXTURE = join(FIXTURES_DIR, 'week-replay-logs.ndjson');

// One window per calendar day in the fixture
const DAY1 = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' };
const DAY2 = { start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z' };
const DAY3 = { start: '2026-09-03T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' };

test('week-replay: known real issue (Fault) is ticketed on first pulse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-wr-'));
  try {
    const db = openDb(join(dir, 'lantern.db'));
    runMigrations(db);
    const agent = ensureDefaultAgent(db, dir);

    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: DAY1.start,
      windowEnd: DAY1.end,
    });

    const result = scanLogs(db, agent, pulseId, DAY1, new FileLogSource(WEEK_FIXTURE));

    assert.equal(result.outcome, 'finding', 'Fault entry must produce a finding on first pulse');
    assert.ok(result.ticketsFiled >= 1, 'at least one ticket must be filed for the Fault entry');

    const tickets = listTickets(db, { status: 'open' });
    const workerTicket = tickets.find((t) => /Worker crashed/i.test(t.title));
    assert.ok(workerTicket !== undefined, 'a ticket for the Worker crash must be in the store');
    assert.equal(workerTicket.origin, 'collector:logs');
    assert.equal(workerTicket.needs_triage, 1);

    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('week-replay: known noisy pattern (Default/info, single pulse) is NOT ticketed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-wr-'));
  try {
    const db = openDb(join(dir, 'lantern.db'));
    runMigrations(db);
    const agent = ensureDefaultAgent(db, dir);

    // Pulse 1: cache miss entries appear (5 occurrences, pulse_count=1)
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: DAY1.start,
      windowEnd: DAY1.end,
    });
    scanLogs(db, agent, p1, DAY1, new FileLogSource(WEEK_FIXTURE));

    // Pulse 2: no cache miss entries in day 2 window → pulse_count stays 1
    const p2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: DAY2.start,
      windowEnd: DAY2.end,
    });
    scanLogs(db, agent, p2, DAY2, new FileLogSource(WEEK_FIXTURE));

    // Only the Fault ticket should exist; no cache-miss ticket
    const tickets = listTickets(db, {});
    const cacheMissTicket = tickets.find((t) => /[Cc]ache miss/i.test(t.title));
    assert.equal(
      cacheMissTicket,
      undefined,
      'cache miss (info, pulse_count=1 after two pulses) must NOT be ticketed',
    );

    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('week-replay: precision on the sample is >= 70%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-wr-'));
  try {
    const db = openDb(join(dir, 'lantern.db'));
    runMigrations(db);
    const agent = ensureDefaultAgent(db, dir);

    // Run two pulses to exercise the full fixture window
    for (const [i, window] of [DAY1, DAY2].entries()) {
      const pulseId = createRunningPulse(db, {
        agentId: agent.id,
        windowStart: window.start,
        windowEnd: window.end,
      });
      scanLogs(db, agent, pulseId, window, new FileLogSource(WEEK_FIXTURE));
      // Pulse 2: real issue already has an open ticket → deduped automatically
      void i;
    }

    // No tickets should be closed as wontfix in this replay run.
    // All filed tickets are genuine — precision should be 100%.
    // Precision has one implementation: the metrics. Tickets
    // were filed just now, so the default 30-day window holds them all.
    const rows = computeMetrics(db).precision;
    const logsRow = rows.find((r) => r.collector === 'collector:logs');
    assert.ok(logsRow !== undefined, 'collector:logs must appear in precision table');
    assert.ok(logsRow.filed >= 1, 'at least one ticket must have been filed');
    assert.ok(
      logsRow.precision >= 0.7,
      `precision must be >= 70%; got ${(logsRow.precision * 100).toFixed(1)}%`,
    );

    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('week-replay: suppression survives a daemon restart (DB close + reopen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-wr-'));
  const dbPath = join(dir, 'lantern.db');
  try {
    // ── Phase 1: run pulse 1, ticket the real issue, close as wontfix ─────────
    let db = openDb(dbPath);
    runMigrations(db);
    let agent = ensureDefaultAgent(db, dir);

    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: DAY1.start,
      windowEnd: DAY1.end,
    });
    scanLogs(db, agent, p1, DAY1, new FileLogSource(WEEK_FIXTURE));

    const tickets = listTickets(db, { status: 'open' });
    const workerTicket = tickets.find((t) => /Worker crashed/i.test(t.title));
    assert.ok(workerTicket !== undefined, 'ticket must exist before suppression test');

    // Close as wontfix → auto-suppresses the fingerprint via handleTicketsClose logic.
    // In tests we call suppressFingerprint directly (same path, no MCP layer needed).
    closeTicket(
      db,
      workerTicket.id,
      { status: 'wontfix', resolution: 'expected crash in test env — not a real issue' },
      { actor: 'human' },
    );
    const { fingerprint } = workerTicket;
    assert.ok(fingerprint !== null, 'ticket must carry fingerprint for suppression test');
    suppressFingerprint(db, fingerprint, 'ticket closed as wontfix');

    // Simulate daemon restart: close the connection.
    db.close();

    // ── Phase 2: reopen DB (restart), run pulse 3 — suppression must hold ─────
    db = openDb(dbPath);
    agent = ensureDefaultAgent(db, dir);

    const p3 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: DAY3.start,
      windowEnd: DAY3.end,
    });
    const result3 = scanLogs(db, agent, p3, DAY3, new FileLogSource(WEEK_FIXTURE));

    assert.equal(
      result3.ticketsFiled,
      0,
      'suppressed fingerprint must not produce a new ticket after restart',
    );

    // The suppression row must still be present in the reopened DB
    const suppressed = db
      .prepare(`SELECT suppressed FROM observations WHERE suppressed = 1`)
      .all() as { suppressed: number }[];
    assert.ok(suppressed.length >= 1, 'suppression row must persist across DB restart');

    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
