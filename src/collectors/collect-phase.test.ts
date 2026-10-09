import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { createRunningPulse, getPulseFindings } from '../store/pulses.ts';
import { listTickets } from '../store/tickets.ts';
import { runCollectors } from './collect-phase.ts';
import { FileInboxSource } from './inbox-bugs.ts';
import { FileLogSource } from './logs-scan.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures', import.meta.url));
const LOGS_FIXTURE = join(FIXTURES_DIR, 'logs.ndjson');
const INBOX_FIXTURE = join(FIXTURES_DIR, 'inbox.json');
const WINDOW = {
  window_start: '2026-09-07T16:00:00.000Z',
  window_end: '2026-09-07T17:00:00.000Z',
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-cp-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('runCollectors: logs source writes findings and files tickets', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.window_start,
      windowEnd: WINDOW.window_end,
    });

    runCollectors(db, agent, pulseId, WINDOW, {
      logSource: new FileLogSource(LOGS_FIXTURE),
    });

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'logs.scan'),
      'must write a logs.scan finding',
    );
    const tickets = listTickets(db, { status: 'open' });
    assert.ok(tickets.length >= 1, 'fault log entry must produce a ticket');
  } finally {
    cleanup();
  }
});

test('runCollectors: inbox source writes findings', () => {
  const { db, agent, cleanup } = setup();
  try {
    const window = {
      window_start: '2026-09-07T08:00:00.000Z',
      window_end: '2026-09-07T09:00:00.000Z',
    };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: window.window_start,
      windowEnd: window.window_end,
    });

    runCollectors(db, agent, pulseId, window, {
      inboxSource: new FileInboxSource(INBOX_FIXTURE),
    });

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'inbox.bugs'),
      'must write an inbox.bugs finding',
    );
  } finally {
    cleanup();
  }
});

test('runCollectors: no sources configured → no findings written', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.window_start,
      windowEnd: WINDOW.window_end,
    });

    // No opts, no env vars → both collectors skipped
    const savedLog = process.env.LANTERN_LOG_SOURCE;
    const savedInbox = process.env.LANTERN_INBOX_SOURCE;
    delete process.env.LANTERN_LOG_SOURCE;
    delete process.env.LANTERN_INBOX_SOURCE;
    try {
      runCollectors(db, agent, pulseId, WINDOW);
    } finally {
      if (savedLog !== undefined) process.env.LANTERN_LOG_SOURCE = savedLog;
      if (savedInbox !== undefined) process.env.LANTERN_INBOX_SOURCE = savedInbox;
    }

    const findings = getPulseFindings(db, pulseId);
    assert.equal(findings.length, 0, 'no sources → no findings');
  } finally {
    cleanup();
  }
});

test('runCollectors: missing log file writes skipped finding', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.window_start,
      windowEnd: WINDOW.window_end,
    });

    runCollectors(db, agent, pulseId, WINDOW, {
      logSource: new FileLogSource('/nonexistent/logs.ndjson'),
    });

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'logs.scan' && f.outcome === 'skipped'),
      'missing log file must write skipped finding',
    );
  } finally {
    cleanup();
  }
});

// sources and the noise allowlist come from the agent config.
test('runCollectors: config log_sources and noise_allowlist drive the scan', () => {
  const { db, agent, cleanup } = setup();
  try {
    const narrow = {
      window_start: '2026-09-07T16:30:00.000Z',
      window_end: '2026-09-07T16:30:02.000Z',
    };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: narrow.window_start,
      windowEnd: narrow.window_end,
    });
    runCollectors(db, agent, pulseId, narrow, {
      logSources: [{ path: LOGS_FIXTURE }],
      noiseAllowlist: [{ source: 'logs', pattern: 'Worker crashed' }],
    });
    const finding = getPulseFindings(db, pulseId).find((f) => f.action_key === 'logs.scan');
    assert.match(finding?.detail ?? '', /1 known_noise/);
    assert.equal(listTickets(db, { status: 'open' }).length, 0);
  } finally {
    cleanup();
  }
});

test('runCollectors: a config inbox path is scanned', () => {
  const { db, agent, cleanup } = setup();
  try {
    const window = {
      window_start: '2026-09-07T08:00:00.000Z',
      window_end: '2026-09-07T12:00:00.000Z',
    };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: window.window_start,
      windowEnd: window.window_end,
    });
    runCollectors(db, agent, pulseId, window, { inboxPath: INBOX_FIXTURE });
    assert.ok(getPulseFindings(db, pulseId).some((f) => f.action_key === 'inbox.bugs'));
  } finally {
    cleanup();
  }
});
