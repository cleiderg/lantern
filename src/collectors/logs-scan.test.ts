/**
 * logs.scan collector acceptance tests.
 *
 * Uses FileLogSource with test/fixtures/logs.ndjson (real issue + benign
 * entries) and a missing-file path for the `skipped` case.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { triageDismiss } from '../actions.ts';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { createLink } from '../store/links.ts';
import { createRunningPulse, getPulseFindings } from '../store/pulses.ts';
import { closeTicket, createTicket, listTickets } from '../store/tickets.ts';
import { buildLogSource } from './collect-phase.ts';
import { FileLogSource, type NoisePattern, PlainTextLogSource, scanLogs } from './logs-scan.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures', import.meta.url));
const LOGS_FIXTURE = join(FIXTURES_DIR, 'logs.ndjson');

// Window that captures entries in the fixture (16:30 entries)
const WINDOW = { start: '2026-09-07T16:00:00.000Z', end: '2026-09-07T17:00:00.000Z' };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-logs-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

// ── acceptance tests ──────────────────────────────────────────────────────

test('logs.scan: Fault entry in fixture results in a filed ticket and finding outcome', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });

    const source = new FileLogSource(LOGS_FIXTURE);
    const result = scanLogs(db, agent, pulseId, WINDOW, source);

    assert.equal(result.outcome, 'finding', 'Fault-level log entry must produce a finding');
    assert.ok(result.ticketsFiled >= 1, 'at least one ticket must be filed');
    assert.ok(result.entriesScanned >= 1, 'entries must be scanned');

    // Ticket exists in the store
    const tickets = listTickets(db, { status: 'open' });
    assert.ok(tickets.length >= 1, 'ticket must exist in store');

    // pulse_findings row written, pointing at a filed ticket
    const findings = getPulseFindings(db, pulseId);
    const finding = findings.find((f) => f.action_key === 'logs.scan' && f.outcome === 'finding');
    assert.ok(finding !== undefined, 'pulse_findings must include a logs.scan:finding row');
    // Same-second tickets have no defined order but their id: look the ticket up by it.
    const t = tickets.find((x) => x.id === finding.ticket_id);
    assert.ok(t !== undefined, 'the finding names one of the filed tickets');
    assert.equal(t.origin, 'collector:logs');
    assert.equal(t.needs_triage, 1);
    assert.ok(t.fingerprint !== null, 'ticket must carry a fingerprint');
  } finally {
    cleanup();
  }
});

test('logs.scan: entries outside window are ignored', () => {
  const { db, agent, cleanup } = setup();
  try {
    // Narrow window that excludes all fixture entries
    const narrowWindow = { start: '2026-09-07T14:00:00.000Z', end: '2026-09-07T15:00:00.000Z' };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: narrowWindow.start,
      windowEnd: narrowWindow.end,
    });

    const source = new FileLogSource(LOGS_FIXTURE);
    const result = scanLogs(db, agent, pulseId, narrowWindow, source);

    assert.equal(result.outcome, 'clean', 'no entries in window → clean');
    assert.equal(result.ticketsFiled, 0);
    assert.equal(result.entriesScanned, 0);

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'logs.scan' && f.outcome === 'clean'),
      'must write a clean finding when no entries match the window',
    );
  } finally {
    cleanup();
  }
});

test('logs.scan: missing log file records skipped, not clean', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });

    const source = new FileLogSource('/nonexistent/path/lantern-logs.ndjson');
    const result = scanLogs(db, agent, pulseId, WINDOW, source);

    assert.equal(result.outcome, 'skipped', 'missing log file must produce skipped, not clean');
    assert.equal(result.ticketsFiled, 0);

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'logs.scan' && f.outcome === 'skipped'),
      'must write a skipped pulse_finding when log data is unavailable',
    );
  } finally {
    cleanup();
  }
});

test('logs.scan: second run with same entry does not re-file an existing open ticket', () => {
  const { db, agent, cleanup } = setup();
  try {
    const source = new FileLogSource(LOGS_FIXTURE);

    // First run — should file tickets
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });
    const first = scanLogs(db, agent, p1, WINDOW, source);
    assert.ok(first.ticketsFiled >= 1, 'first run must file at least one ticket');

    // Second run — same fault entry, same fingerprint → open ticket exists → no duplicate
    const p2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });
    const second = scanLogs(db, agent, p2, WINDOW, source);
    assert.equal(second.ticketsFiled, 0, 'second run must not file duplicate tickets');
  } finally {
    cleanup();
  }
});

test('allowlist entry matching regex counts as known_noise, no ticket filed', () => {
  const { db, agent, cleanup } = setup();
  try {
    // Narrow window captures only the first entry (Worker crashed Fault at 16:30:00)
    const narrowWindow = { start: '2026-09-07T16:30:00.000Z', end: '2026-09-07T16:30:02.000Z' };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: narrowWindow.start,
      windowEnd: narrowWindow.end,
    });

    const allowlist: NoisePattern[] = [{ source: 'logs', pattern: 'Worker crashed' }];
    const source = new FileLogSource(LOGS_FIXTURE);
    const result = scanLogs(db, agent, pulseId, narrowWindow, source, allowlist);

    assert.equal(result.knownNoise, 1, 'matched entry must be counted as known_noise');
    assert.equal(result.ticketsFiled, 0, 'no ticket must be filed for allowlisted entry');

    const tickets = listTickets(db, { status: 'open' });
    assert.equal(tickets.length, 0, 'no open tickets from allowlisted fault');

    const findings = getPulseFindings(db, pulseId);
    const cleanFinding = findings.find(
      (f) => f.action_key === 'logs.scan' && f.outcome === 'clean',
    );
    assert.ok(cleanFinding !== undefined, 'must write a clean finding');
    assert.match(cleanFinding.detail ?? '', /known_noise/, 'detail must mention known_noise count');
  } finally {
    cleanup();
  }
});

test('FileLogSource: returns no_data for a missing file', () => {
  const source = new FileLogSource('/does/not/exist.ndjson');
  const result = source.query({ start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
  assert.equal(result.kind, 'no_data');
});

test('FileLogSource: parses fixture and maps messageType to severity', () => {
  const source = new FileLogSource(LOGS_FIXTURE);
  const result = source.query(WINDOW);
  assert.equal(result.kind, 'entries');
  if (result.kind !== 'entries') return;

  assert.ok(result.entries.length >= 1, 'must parse at least one entry in window');

  const fault = result.entries.find((e) => e.severity === 'fault');
  assert.ok(fault !== undefined, 'must parse Fault entry as severity=fault');
  assert.match(fault.message, /Worker crashed/);
  assert.equal(fault.code_location, 'com.myapp:worker');
});

// ── PlainTextLogSource ──────────────────────────────────────────────────

test('PlainTextLogSource: returns no_data for a missing file', () => {
  const source = new PlainTextLogSource('/does/not/exist.log');
  const result = source.query({ start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
  assert.equal(result.kind, 'no_data');
});

// PlainTextLogSource parses "YYYY-MM-DD HH:MM:SS" as LOCAL time. To avoid
// timezone-related flakiness the tests build both log entries and query windows
// from the same local-time base so they are always consistent.
function localTs(localIso: string): string {
  // localIso: 'YYYY-MM-DDTHH:MM:SS' (no Z = local-time)
  // Returns the 'YYYY-MM-DD HH:MM:SS' plain-text format the source expects.
  const d = new Date(localIso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

test('PlainTextLogSource: maps [error]→crash, [warn]→warning, [info]→info', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-plainlog-'));
  const logPath = join(dir, 'app.log');
  try {
    // Window: local 16:00–17:00. Three entries inside, one outside at 14:00.
    const winStart = new Date('2026-09-07T16:00:00').toISOString();
    const winEnd = new Date('2026-09-07T17:00:00').toISOString();

    writeFileSync(
      logPath,
      [
        `${localTs('2026-09-07T16:30:00')} [error] [worker] Crash in processing`,
        `${localTs('2026-09-07T16:30:01')} [warn] [api] Rate limit hit`,
        `${localTs('2026-09-07T16:30:02')} [info] [main] App started`,
        `${localTs('2026-09-07T14:00:00')} [error] [worker] Outside window error`,
      ].join('\n'),
    );

    const source = new PlainTextLogSource(logPath);
    const result = source.query({ start: winStart, end: winEnd });
    assert.equal(result.kind, 'entries');
    if (result.kind !== 'entries') return;

    assert.equal(
      result.entries.length,
      3,
      'should parse 3 entries in window, excluding out-of-window',
    );

    const errEntry = result.entries.find((e) => e.message === 'Crash in processing');
    assert.ok(errEntry, '[error] entry should be present');
    assert.equal(errEntry?.severity, 'crash', '[error] must map to crash');
    assert.equal(errEntry?.code_location, 'worker');

    const warnEntry = result.entries.find((e) => e.message === 'Rate limit hit');
    assert.ok(warnEntry, '[warn] entry should be present');
    assert.equal(warnEntry?.severity, 'warning', '[warn] must map to warning');

    const infoEntry = result.entries.find((e) => e.message === 'App started');
    assert.ok(infoEntry, '[info] entry should be present');
    assert.equal(infoEntry?.severity, 'info', '[info] must map to info');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('PlainTextLogSource: returns no_data when no entries fall in window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-plainlog-empty-'));
  const logPath = join(dir, 'app.log');
  try {
    // Entry at local 14:00, window is local 16:00–17:00 → outside → no_data
    writeFileSync(logPath, `${localTs('2026-09-07T14:00:00')} [error] [worker] Outside window\n`);
    const source = new PlainTextLogSource(logPath);
    const winStart = new Date('2026-09-07T16:00:00').toISOString();
    const winEnd = new Date('2026-09-07T17:00:00').toISOString();
    const result = source.query({ start: winStart, end: winEnd });
    assert.equal(
      result.kind,
      'no_data',
      'no entries in window must return no_data, not empty entries',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── buildLogSource auto-detect ─────────────────────────────────────────

test('buildLogSource: returns null when no path provided', () => {
  assert.equal(buildLogSource(), null);
});

test('buildLogSource: returns FileLogSource for ndjson file', () => {
  const source = buildLogSource(LOGS_FIXTURE);
  assert.ok(source !== null, 'must return a source for a real ndjson file');
  const result = source.query(WINDOW);
  assert.equal(result.kind, 'entries', 'FileLogSource must parse ndjson fixture entries');
});

test('buildLogSource: returns PlainTextLogSource for plain-text log file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-detect-plain-'));
  const logPath = join(dir, 'app.log');
  try {
    // Use local-time-consistent timestamps and window (see localTs helper above)
    const winStart = new Date('2026-09-07T16:00:00').toISOString();
    const winEnd = new Date('2026-09-07T17:00:00').toISOString();
    writeFileSync(logPath, `${localTs('2026-09-07T16:30:00')} [info] [app] hello\n`);
    const source = buildLogSource(logPath);
    assert.ok(source !== null);
    const result = source.query({ start: winStart, end: winEnd });
    assert.equal(result.kind, 'entries', 'PlainTextLogSource must parse plain-text entries');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('buildLogSource: returns PlainTextLogSource for non-existent file path', () => {
  const source = buildLogSource('/nonexistent/path/app.log');
  assert.ok(source !== null, 'non-existent path should yield PlainTextLogSource, not null');
  const result = source.query(WINDOW);
  assert.equal(result.kind, 'no_data', 'PlainTextLogSource on missing file must return no_data');
});

// ── INFO lines ───────────────────────────────────────────────────────────────

test('scanLogs: repeated INFO lines across pulses file no ticket and are reported as counted', () => {
  const { dir, db, agent, cleanup } = setup();
  try {
    const log = join(dir, 'kuma.log');
    const line = (t: string) => `${t} [info] [socket] Socket connected from 127.0.0.1`;
    writeFileSync(
      log,
      ['2026-09-07 16:00:01', '2026-09-07 16:00:02', '2026-09-07 17:00:01', '2026-09-07 17:00:02']
        .map(line)
        .join('\n'),
    );
    const src = new PlainTextLogSource(log);
    const win = (s: string, e: string) => ({
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
    });
    for (const [s, e] of [
      ['2026-09-07 16:00:00', '2026-09-07 16:30:00'],
      ['2026-09-07 17:00:00', '2026-09-07 17:30:00'],
    ]) {
      const w = win(s as string, e as string);
      const pulseId = createRunningPulse(db, {
        agentId: agent.id,
        windowStart: w.start,
        windowEnd: w.end,
      });
      const r = scanLogs(db, agent, pulseId, w, src);
      assert.equal(r.ticketsFiled, 0);
      assert.equal(r.infoCounted, 2);
      const f = getPulseFindings(db, pulseId).find((x) => x.action_key === 'logs.scan');
      assert.match(f?.detail ?? '', /2 info line\(s\) counted, not ticketed/);
    }
    assert.equal(listTickets(db, {}).length, 0);
  } finally {
    cleanup();
  }
});

// ── a recurring error closed as a duplicate stays on its open canonical ──

test('logs.scan: an error closed as a duplicate of an open ticket is tracked there, not re-filed', () => {
  const { db, agent, cleanup } = setup();
  try {
    const source = new FileLogSource(LOGS_FIXTURE);
    const pulse = () =>
      createRunningPulse(db, {
        agentId: agent.id,
        windowStart: WINDOW.start,
        windowEnd: WINDOW.end,
      });
    const first = scanLogs(db, agent, pulse(), WINDOW, source);
    assert.ok(first.ticketsFiled >= 1);

    // A human report already covers it: the agent closes the log tickets as duplicates of it.
    const canonical = createTicket(
      db,
      { kind: 'bug', title: 'Crash on save (user report)', body: 'b', origin: 'human' },
      { actor: 'human' },
    );
    const filed = listTickets(db, { status: 'open' }).filter((t) => t.origin === 'collector:logs');
    for (const t of filed) {
      createLink(db, { from_ticket: t.id, to_ticket: canonical, rel: 'duplicates', note: null });
      closeTicket(
        db,
        t.id,
        { status: 'duplicate', resolution: `same as #${canonical}` },
        { actor: 'agent' },
      );
    }

    const p2 = pulse();
    const second = scanLogs(db, agent, p2, WINDOW, source);
    assert.equal(second.ticketsFiled, 0, 'no re-file while the canonical ticket is open');
    assert.equal(second.trackedOnExisting, filed.length);
    const row = getPulseFindings(db, p2).find((f) => f.action_key === 'logs.scan');
    assert.equal(row?.outcome, 'clean');
    assert.match(row?.detail ?? '', new RegExp(`already tracked on #${canonical}`));

    // Fixed and closed — the same error coming back is a regression: file it again.
    closeTicket(db, canonical, { status: 'closed', resolution: 'fixed' }, { actor: 'human' });
    const third = scanLogs(db, agent, pulse(), WINDOW, source);
    assert.equal(third.ticketsFiled, filed.length, 'a recurrence after the fix is news');
  } finally {
    cleanup();
  }
});

test('logs.scan: a log ticket a human dismissed in Triage is not re-filed', () => {
  const { db, agent, cleanup } = setup();
  try {
    const source = new FileLogSource(LOGS_FIXTURE);
    const pulse = () =>
      createRunningPulse(db, {
        agentId: agent.id,
        windowStart: WINDOW.start,
        windowEnd: WINDOW.end,
      });
    const first = scanLogs(db, agent, pulse(), WINDOW, source);
    assert.ok(first.ticketsFiled >= 1);
    for (const t of listTickets(db, { status: 'open' }).filter(
      (x) => x.origin === 'collector:logs',
    )) {
      assert.equal(triageDismiss(db, t.id, 'known noise, not a bug').ok, true);
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(
        scanLogs(db, agent, pulse(), WINDOW, source).ticketsFiled,
        0,
        `scan ${i + 2} files nothing`,
      );
    }
  } finally {
    cleanup();
  }
});
