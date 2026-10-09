/**
 * inbox.bugs collector acceptance tests.
 *
 * Uses FileInboxSource with test/fixtures/inbox.json (bugs + thanks + feature
 * requests) and keyword classifier. Verifies classification, prior-art links,
 * and deduplication on origin_ref.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { createRunningPulse, getPulseFindings } from '../store/pulses.ts';
import { closeTicket, createTicket, listTickets } from '../store/tickets.ts';
import {
  bugEvidence,
  bugScore,
  FileInboxSource,
  keywordClassifier,
  scanInbox,
} from './inbox-bugs.ts';
import type { Email } from './types.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures', import.meta.url));
const INBOX_FIXTURE = join(FIXTURES_DIR, 'inbox.json');

// Window that captures all fixture emails (08:00–09:00)
const WINDOW = { start: '2026-09-07T08:00:00.000Z', end: '2026-09-07T09:00:00.000Z' };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-inbox-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

// ── acceptance tests ──────────────────────────────────────────────────────

test('inbox.bugs: bug emails produce tickets; thanks and feature requests do not', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });

    const source = new FileInboxSource(INBOX_FIXTURE);
    const result = scanInbox(db, agent, pulseId, WINDOW, source);

    assert.equal(result.outcome, 'finding', 'bug emails must produce finding outcome');
    // Fixture has 2 bug emails and 2 non-bug (thanks + feature)
    assert.equal(result.fetched, 4, 'all 4 fixture emails must be fetched');
    assert.equal(result.filed, 2, 'exactly 2 bug tickets must be filed');
    assert.equal(result.deduped, 0, 'no deduplication on first run');

    // Tickets exist in store with correct metadata
    const tickets = listTickets(db, { status: 'open' });
    assert.equal(tickets.length, 2);
    for (const t of tickets) {
      assert.equal(t.origin, 'collector:email');
      assert.equal(t.needs_triage, 1);
      assert.ok(t.origin_ref !== null, 'ticket must carry the message-id as origin_ref');
    }

    // pulse_findings rows
    const findings = getPulseFindings(db, pulseId);
    const bugFindings = findings.filter(
      (f) => f.action_key === 'inbox.bugs' && f.outcome === 'finding',
    );
    assert.equal(bugFindings.length, 2, 'must write one finding row per filed ticket');
  } finally {
    cleanup();
  }
});

test('inbox.bugs: filed tickets include prior-art block when related tickets exist', () => {
  const { db, agent, cleanup } = setup();
  try {
    // Pre-seed a closed ticket whose title+resolution contains the same tokens
    // as the email subject ("App crashes when exporting data") so FTS AND
    // semantics find it.
    const priorId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'App crashes when exporting data — prior incident',
        body: 'App crashes when exporting data on macOS.',
        origin: 'human',
        agent_id: agent.id,
      },
      { actor: 'human' },
    );
    closeTicket(
      db,
      priorId,
      {
        status: 'closed',
        resolution: 'Fixed timeout when exporting data — app no longer crashes.',
      },
      { actor: 'human' },
    );

    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });

    const source = new FileInboxSource(INBOX_FIXTURE);
    scanInbox(db, agent, pulseId, WINDOW, source);

    // The "App crashes when exporting" ticket should have prior art linked
    const tickets = listTickets(db, { status: 'open' });
    const crashTicket = tickets.find((t) => /crash/i.test(t.title));
    assert.ok(crashTicket !== undefined, 'crash ticket must exist');
    assert.match(crashTicket.body, /#\d+/, 'ticket body must include a prior-art reference');
  } finally {
    cleanup();
  }
});

test('inbox.bugs: re-running dedupes on origin_ref (message-id)', () => {
  const { db, agent, cleanup } = setup();
  try {
    const source = new FileInboxSource(INBOX_FIXTURE);

    // First run
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });
    const first = scanInbox(db, agent, p1, WINDOW, source);
    assert.equal(first.filed, 2);

    // Second run — same window, same message-ids → all deduped
    const p2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });
    const second = scanInbox(db, agent, p2, WINDOW, source);
    assert.equal(second.filed, 0, 'second run must file 0 new tickets (all deduped)');
    assert.equal(second.deduped, 2, 'both bug emails must be deduped by origin_ref');

    // the check still ran, so it still leaves its row.
    const rows = db
      .prepare(
        `SELECT outcome, detail FROM pulse_findings WHERE pulse_id = ? AND action_key = 'inbox.bugs'`,
      )
      .all(p2) as { outcome: string; detail: string }[];
    assert.equal(rows.length, 1, 'an all-duplicate scan records exactly one finding');
    assert.equal(rows[0]?.outcome, 'clean');
    assert.match(rows[0]?.detail ?? '', /2 already ticketed/);
  } finally {
    cleanup();
  }
});

test('inbox.bugs: empty window produces clean finding, no tickets', () => {
  const { db, agent, cleanup } = setup();
  try {
    // Window outside all fixture email dates
    const emptyWindow = {
      start: '2026-09-08T00:00:00.000Z',
      end: '2026-09-09T00:00:00.000Z',
    };
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: emptyWindow.start,
      windowEnd: emptyWindow.end,
    });

    const source = new FileInboxSource(INBOX_FIXTURE);
    const result = scanInbox(db, agent, pulseId, emptyWindow, source);

    assert.equal(result.outcome, 'clean');
    assert.equal(result.fetched, 0);
    assert.equal(result.filed, 0);

    const findings = getPulseFindings(db, pulseId);
    assert.ok(
      findings.some((f) => f.action_key === 'inbox.bugs' && f.outcome === 'clean'),
      'must write a clean finding for empty window',
    );
  } finally {
    cleanup();
  }
});

test('inbox.bugs: missing inbox file produces clean finding (no messages)', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });

    const source = new FileInboxSource('/nonexistent/inbox.json');
    const result = scanInbox(db, agent, pulseId, WINDOW, source);

    assert.equal(result.outcome, 'clean', 'missing inbox file → no messages → clean');
    assert.equal(result.fetched, 0);
  } finally {
    cleanup();
  }
});

// ── the classifier reads the shape of a bug report ─────────────────
// The old single regex matched "issue", so every real issue report was a bug
// (63.7% real-bug precision on a trial against a real project's issues). These
// are synthetic messages modelled on common tracker templates.

const mail = (subject: string, body: string): Email => ({
  id: subject,
  from: 'u@example.com',
  subject,
  body,
  date: '2026-09-07T08:30:00.000Z',
});
const isBug = (subject: string, body: string) =>
  keywordClassifier([mail(subject, body)])[0]?.is_bug;

test('classifier: a templated bug report with steps and expected/actual is a bug', () => {
  assert.equal(
    isBug(
      'Status page shows stale data',
      '### Steps to reproduce\n1. Create a status page\n2. Pause a monitor\n### Expected behavior\nThe page shows it paused.\n### Actual behavior\nIt still shows up.',
    ),
    true,
  );
});

test('classifier: a stack trace with failure language is a bug', () => {
  assert.equal(
    isBug(
      'Server crashes on startup',
      'After upgrading it crashes:\nTypeError: Cannot read properties of undefined (reading "id")\n    at Monitor.check (server/model/monitor.js:120:5)',
    ),
    true,
  );
});

test('classifier: feature requests are not bugs, even when they mention failures', () => {
  assert.equal(
    isBug('[Feature] Matrix notifications', 'It would be great to support Matrix rooms.'),
    false,
  );
  assert.equal(
    isBug('Retry webhooks', 'Please add a retry option when a webhook request fails.'),
    false,
  );
  assert.equal(
    isBug('Feature request: export to CSV', 'Add the ability to export history.'),
    false,
  );
});

test('classifier: support questions are not bugs unless they carry reproduction evidence', () => {
  assert.equal(
    isBug('How do I put Kuma behind nginx?', 'Is there a way to set a base path? I get an error.'),
    false,
  );
  assert.equal(isBug('Is it possible to monitor UDP?', 'Any idea how?'), false);
  assert.equal(
    isBug(
      'Help: crash after login?',
      'Steps to reproduce:\n1. Log in\n2. Open settings\nTypeError: x is undefined\n    at Settings.load (src/settings.js:10:3)',
    ),
    true,
    'a question that carries steps and a stack trace is a bug report',
  );
});

test('classifier: thanks and vague complaints are not bugs', () => {
  assert.equal(isBug('Thank you!', 'Love this project, great work.'), false);
  assert.equal(
    isBug('Not great', 'This is an issue for me.'),
    false,
    '"issue" alone no longer counts',
  );
});

// ── the evidence the page shows is the evidence that decided ─────────────

test('bugEvidence: labelled signals that sum to bugScore, for every fixture message', () => {
  const files = ['inbox.json', 'adversarial-inbox.json'].map(
    (f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as Email[],
  );
  for (const e of files.flat()) {
    const ev = bugEvidence(e);
    assert.equal(ev.score, bugScore(e), e.subject);
    assert.equal(
      ev.signals.reduce((n, s) => n + s.weight, 0),
      ev.score,
      e.subject,
    );
    for (const s of ev.signals) assert.ok(s.label.length > 0 && s.weight !== 0);
  }
  const e = bugEvidence(
    mail(
      'Crash when saving?',
      'Steps to reproduce:\n1. Save\nExpected behavior: saved\nActual behavior: it crashes',
    ),
  );
  assert.deepEqual(
    e.signals.map((s) => s.label).sort(),
    [
      'crash, exception or 5xx',
      'expected and actual behaviour',
      'question or help phrasing',
      'reproduction steps',
    ].sort(),
  );
});
