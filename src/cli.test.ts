import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeHarness } from '../test/support/fake-harness.ts';
import { ensureDefaultAgent, getAgent, setAgentState } from './agent.ts';
import { run, USAGE, version } from './cli.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { createEscalation } from './store/escalations.ts';
import { createLink } from './store/links.ts';
import { getPulseFindings } from './store/pulses.ts';
import { createSession, updateSession as updateSes } from './store/sessions.ts';
import { closeTicket, createTicket, updateTicket } from './store/tickets.ts';

/** A throwaway Writable that accumulates everything written, so run()'s output
 *  is captured instead of polluting the test report. */
/**
 * Init + a default agent whose workdir is an empty, clean git repo. Gate 5
 * is on, so a pulse needs a workdir `git status` can vouch
 * for; the Lantern dir itself is neither a repo nor clean.
 */
function initWithCleanWorkdir(lanternDir: string): void {
  initLantern(lanternDir);
  const work = join(lanternDir, 'work');
  execFileSync('git', ['init', '-q', work]);
  const db = openDb(join(lanternDir, 'lantern.db'));
  ensureDefaultAgent(db, work);
  db.close();
}

function sink(): Writable & { text: string } {
  const s = new Writable({
    write(chunk, _enc, cb) {
      (s as unknown as { text: string }).text += chunk.toString();
      cb();
    },
  }) as Writable & { text: string };
  s.text = '';
  return s;
}

test('USAGE lists the core commands', () => {
  for (const cmd of ['init', 'start', 'status', 'pulse', 'tickets', 'ticket', 'triage', 'doctor']) {
    assert.match(USAGE, new RegExp(`\\b${cmd}\\b`), `usage should mention '${cmd}'`);
  }
});

test('--help, -h, help, and no args all print usage and exit 0', () => {
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    const out = sink();
    const code = run(argv, out, sink());
    assert.equal(code, 0);
    assert.ok(out.text.startsWith('lantern — a local heartbeat orchestrator'));
  }
});

test('--version prints the package version and exits 0', () => {
  const out = sink();
  const code = run(['--version'], out, sink());
  assert.equal(code, 0);
  assert.equal(out.text, `lantern ${version()}\n`);
});

test('an unknown command exits 2 and prints usage to stderr', () => {
  const out = sink();
  const err = sink();
  const code = run(['definitely-not-a-command'], out, err);
  assert.equal(code, 2);
  assert.equal(out.text, '');
  assert.match(err.text, /unknown or unimplemented command/);
  assert.ok(err.text.includes('Usage: lantern <command>'));
});

// ── ledger CLI tests ──────────────────────────────────────────────────────

function withSeededDb(fn: (lanternDir: string) => void): void {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      const ctx = { actor: 'test' };
      // ticket 1: open auth bug
      createTicket(
        db,
        {
          kind: 'bug',
          title: 'Auth JWT token expires login session',
          body: 'Users logged out when JWT auth token expires',
          origin: 'human',
          priority: 'p2',
        },
        ctx,
      );
      // ticket 2: open unrelated bug, needs_triage=true
      createTicket(
        db,
        {
          kind: 'bug',
          title: 'API rate limit returns 429 error',
          body: 'Handle HTTP 429 with backoff',
          origin: 'human',
          needs_triage: true,
        },
        ctx,
      );
      // ticket 3: chore that will be closed+resolved
      createTicket(
        db,
        {
          kind: 'chore',
          title: 'Database connection pool setup',
          body: 'Configure pool size',
          origin: 'human',
        },
        ctx,
      );
      closeTicket(
        db,
        3,
        { status: 'closed', resolution: 'Pool configured to 20 connections' },
        ctx,
      );
      // link 1 → 2
      createLink(db, { from_ticket: 1, to_ticket: 2, rel: 'relates_to' });
      // add a comment to ticket 1
      updateTicket(
        db,
        1,
        { body: 'Updated: users logged out when JWT auth token expires during session' },
        ctx,
      );
    } finally {
      db.close();
    }
    fn(lanternDir);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('lantern tickets: errors when DB not initialized', () => {
  const err = sink();
  const code = run(['tickets'], sink(), err, { lanternDir: '/nonexistent/lantern-test-path' });
  assert.equal(code, 1);
  assert.match(err.text, /not initialized/);
});

test('lantern tickets: lists all tickets', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['tickets'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /#1/);
    assert.match(out.text, /Auth JWT token/);
    assert.match(out.text, /#2/);
    assert.match(out.text, /#3/);
    assert.match(out.text, /3 ticket/);
  });
});

test('lantern tickets --status open: filters by status', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['tickets', '--status', 'open'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /#1/);
    assert.match(out.text, /#2/);
    assert.ok(!out.text.includes('#3'), 'closed ticket should not appear');
  });
});

test('lantern tickets --search: returns FTS matches', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['tickets', '--search', 'auth jwt token'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /#1/);
    assert.match(out.text, /Auth JWT token/);
  });
});

test('lantern tickets --search: returns "no tickets" when nothing matches', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['tickets', '--search', 'zxyqwert nonexistent xyzzy'], out, sink(), {
      lanternDir,
    });
    assert.equal(code, 0);
    assert.match(out.text, /no tickets/);
  });
});

test('lantern ticket <id>: prints full detail with events and links', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['ticket', '1'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /#1/);
    assert.match(out.text, /Auth JWT token expires login session/);
    assert.match(out.text, /Events/);
    assert.match(out.text, /Links/);
    // should show the link to ticket 2
    assert.match(out.text, /#2/);
    // should show at least the 'created' event
    assert.match(out.text, /created/);
  });
});

test('lantern ticket <id>: shows resolution for closed ticket', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    run(['ticket', '3'], out, sink(), { lanternDir });
    assert.match(out.text, /Resolution/);
    assert.match(out.text, /Pool configured/);
    assert.match(out.text, /\[closed\]/);
  });
});

test('lantern ticket <id>: exits 1 when ticket not found', () => {
  withSeededDb((lanternDir) => {
    const err = sink();
    const code = run(['ticket', '999'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  });
});

test('lantern ticket: exits 1 with no id given', () => {
  withSeededDb((lanternDir) => {
    const err = sink();
    const code = run(['ticket'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /usage/);
  });
});

test('lantern triage: lists needs_triage=1 tickets', () => {
  withSeededDb((lanternDir) => {
    const out = sink();
    const code = run(['triage'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    // only ticket 2 has needs_triage=true
    assert.match(out.text, /#2/);
    assert.match(out.text, /API rate limit/);
    assert.ok(!out.text.includes('#1'), 'ticket 1 does not need triage');
    assert.ok(!out.text.includes('#3'), 'ticket 3 does not need triage');
  });
});

test('lantern triage: shows "no tickets" when none need triage', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-cli-empty-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['triage'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /no tickets need triage/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern triage accept/dismiss + origin grouping ────────────────────────

function withTriageQueue(
  fn: (lanternDir: string, ids: { selfId: number; collectorId: number }) => void,
): void {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-triage-hygiene-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const ctx = { actor: 'test' };
    const selfId = createTicket(
      db,
      {
        kind: 'enhancement',
        title: 'Refactor the digest builder',
        body: 'Noticed while working on something else',
        origin: 'agent:self',
        needs_triage: true,
      },
      ctx,
    );
    const collectorId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'Flaky log line',
        body: 'Repeated warning in logs',
        origin: 'collector:logs',
        needs_triage: true,
      },
      ctx,
    );
    db.close();
    fn(lanternDir, { selfId, collectorId });
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('lantern triage: groups the queue by origin', () => {
  withTriageQueue((lanternDir) => {
    const out = sink();
    const code = run(['triage'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /agent:self \(1\)/);
    assert.match(out.text, /collector:logs \(1\)/);
  });
});

test('lantern triage accept <id>: clears needs_triage', () => {
  withTriageQueue((lanternDir, { selfId }) => {
    const out = sink();
    const code = run(['triage', 'accept', String(selfId)], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, new RegExp(`#${selfId}`));
    assert.match(out.text, /accepted/);

    const db = openDb(join(lanternDir, 'lantern.db'));
    const row = db.prepare('SELECT needs_triage FROM tickets WHERE id = ?').get(selfId) as
      | { needs_triage: number }
      | undefined;
    db.close();
    assert.equal(row?.needs_triage, 0);
  });
});

test('lantern triage accept: exits 1 for an unknown id', () => {
  withTriageQueue((lanternDir) => {
    const err = sink();
    const code = run(['triage', 'accept', '999'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  });
});

test('lantern triage accept: exits 1 when the ticket does not need triage', () => {
  withTriageQueue((lanternDir, { selfId }) => {
    run(['triage', 'accept', String(selfId)], sink(), sink(), { lanternDir });
    const err = sink();
    const code = run(['triage', 'accept', String(selfId)], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /does not need triage/);
  });
});

test('lantern triage dismiss <id> <reason>: closes as wontfix with the reason as resolution', () => {
  withTriageQueue((lanternDir, { collectorId }) => {
    const out = sink();
    const code = run(
      ['triage', 'dismiss', String(collectorId), 'known', 'noisy', 'pattern'],
      out,
      sink(),
      { lanternDir },
    );
    assert.equal(code, 0);
    assert.match(out.text, /dismissed/);

    const db = openDb(join(lanternDir, 'lantern.db'));
    const row = db
      .prepare('SELECT status, resolution FROM tickets WHERE id = ?')
      .get(collectorId) as { status: string; resolution: string } | undefined;
    db.close();
    assert.equal(row?.status, 'wontfix');
    assert.equal(row?.resolution, 'known noisy pattern');
  });
});

test('lantern triage dismiss: exits 1 for an unknown id', () => {
  withTriageQueue((lanternDir) => {
    const err = sink();
    const code = run(['triage', 'dismiss', '999', 'reason'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  });
});

test('lantern triage dismiss: usage error when reason missing', () => {
  withTriageQueue((lanternDir, { selfId }) => {
    const err = sink();
    const code = run(['triage', 'dismiss', String(selfId)], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /usage/);
  });
});

// ── pause / resume ────────────────────────────────────────────────────────

test('lantern pause: creates PAUSED file', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pause-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['pause'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.ok(existsSync(join(lanternDir, 'PAUSED')), 'PAUSED file should exist');
    assert.match(out.text, /paused/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern resume: removes PAUSED file', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-resume-'));
  try {
    initLantern(lanternDir);
    run(['pause'], sink(), sink(), { lanternDir });
    assert.ok(existsSync(join(lanternDir, 'PAUSED')), 'should be paused first');

    const out = sink();
    const code = run(['resume'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.ok(!existsSync(join(lanternDir, 'PAUSED')), 'PAUSED file should be removed');
    assert.match(out.text, /kill switch cleared|resumed/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern resume: idempotent when not paused', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-resume-noop-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['resume'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /not paused|nothing to resume/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern resume: clears a Law 7 trip so the breach is recoverable', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-resume-tripped-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'tripped', 'daily budget breached: $20.00 of $15.00');
    db.close();

    const out = sink();
    const code = run(['resume'], out, sink(), { lanternDir });
    assert.equal(code, 0);

    const check = openDb(join(lanternDir, 'lantern.db'));
    const after = getAgent(check, agent.id);
    check.close();
    assert.equal(after?.state, 'running', 'a tripped agent must be revivable by `lantern resume`');
    assert.equal(after?.paused_reason, null, 'the stale breach reason should be cleared too');
    assert.match(out.text, /was tripped/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern resume: leaves a stopped agent stopped', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-resume-stopped-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'stopped', 'operator stopped it');
    db.close();

    run(['resume'], sink(), sink(), { lanternDir });

    const check = openDb(join(lanternDir, 'lantern.db'));
    const after = getAgent(check, agent.id);
    check.close();
    assert.equal(after?.state, 'stopped', 'resume reverses a pause or a trip, not a stop');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── pulse --now (non-dry-run) + status shows pulses ──────────────────────

test('lantern pulse --now: stamps last_pulse_at so status stops saying "never"', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pulse-stamp-'));
  try {
    initWithCleanWorkdir(lanternDir);
    const harness = new FakeHarness({ result: 'heartbeat.selfcheck: ok', costUsd: 0.01 });
    run(['pulse', '--now'], sink(), sink(), { lanternDir, harness });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const row = getAgent(db, agent.id);
    db.close();
    assert.ok(
      row?.last_pulse_at,
      'a manual pulse must stamp the agent — the dead-man alert reads this field',
    );

    // And the status screen reflects it rather than reporting a dead loop.
    const out = sink();
    run(['status'], out, sink(), { lanternDir });
    assert.doesNotMatch(out.text, /last_pulse=never/);
    assert.match(out.text, /last_pulse=\d{4}-\d{2}-\d{2}/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern pulse --now: runs orchestrator turn and writes pulse row + finding', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pulse-now-'));
  try {
    initWithCleanWorkdir(lanternDir);
    const out = sink();
    const harness = new FakeHarness({
      result: 'heartbeat.selfcheck: daemon healthy',
      costUsd: 0.01,
    });
    run(['pulse', '--now'], out, sink(), { lanternDir, harness });
    // FakeHarness resolves synchronously; wait for all microtasks to flush
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // The fake turn records no finding of its own, so the daemon writes `skipped`
    // and the pulse status follows it — never `clean`.
    assert.match(out.text, /pulse \d+ skipped/);

    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      const pulses = db.prepare("SELECT * FROM pulses WHERE status != 'running'").all() as Array<{
        id: number;
        status: string;
      }>;
      assert.ok(pulses.length >= 1, 'should have a completed pulse row');
      const pulse = pulses[0];
      assert.ok(pulse !== undefined);
      const findings = getPulseFindings(db, pulse.id);
      assert.ok(findings.length >= 1, 'pulse should have ≥1 finding');
      assert.equal(findings[0]?.action_key, 'heartbeat.selfcheck');
      // FakeHarness records no own finding → daemon writes 'skipped' not 'clean'
      assert.equal(findings[0]?.outcome, 'skipped');
    } finally {
      db.close();
    }
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern status: shows last 24h pulses with findings', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-pulses-'));
  try {
    initWithCleanWorkdir(lanternDir);
    // Fire a pulse to generate a row
    const harness = new FakeHarness({
      result: 'heartbeat.selfcheck: daemon healthy',
      costUsd: 0.01,
    });
    run(['pulse', '--now'], sink(), sink(), { lanternDir, harness });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /Pulses \(last 24h/);
    // FakeHarness records no own finding, so daemon writes 'skipped' not 'clean'
    assert.match(out.text, /heartbeat\.selfcheck:skipped/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern sessions ─────────────────────────────────────────────────────────

test('lantern sessions: lists sessions from the store', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-sessions-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    createSession(db, {
      id: 'test-session-0001-0000-0000-000000000001',
      agentId: agent.id,
      tier: 'read_only',
    });
    db.close();

    const out = sink();
    const code = run(['sessions'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /session/i);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern sessions --live: shows "no live sessions" when none are running', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-sessions-live-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['sessions', '--live'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /no live sessions/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern kill ─────────────────────────────────────────────────────────────

test('lantern kill: exits 1 when session not found', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-kill-'));
  try {
    initLantern(lanternDir);
    const err = sink();
    const code = run(['kill', 'nonexistent-id'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern kill: exits 1 when session is already done', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-kill-done-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const id = 'done-session-0000-0000-0000-000000000001';
    createSession(db, { id, agentId: agent.id, tier: 'read_only' });
    updateSes(db, id, { status: 'done' });
    db.close();

    const err = sink();
    const code = run(['kill', id], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /already done/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern pause kills live sessions ───────────────────────────────────────

test('lantern pause: kills live sessions and notes count', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pause-kill-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const sid = 'live-session-0000-0000-0000-000000000001';
    createSession(db, { id: sid, agentId: agent.id, tier: 'read_only' });
    // Leave status as 'starting' (live)
    db.close();

    const out = sink();
    const code = run(['pause'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /paused/);
    assert.match(out.text, /killed 1 session/);

    const db2 = openDb(join(lanternDir, 'lantern.db'));
    try {
      const row = db2.prepare('SELECT status FROM sessions WHERE id = ?').get(sid) as
        | { status: string }
        | undefined;
      assert.equal(row?.status, 'killed');
    } finally {
      db2.close();
    }
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern logs ────────────────────────────────────────────────────────────

test('lantern logs: exits 1 when pulse not found', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-logs-'));
  try {
    initLantern(lanternDir);
    const err = sink();
    const code = run(['logs', '99999'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern logs: prints findings for a completed pulse', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-logs-pulse-'));
  try {
    initWithCleanWorkdir(lanternDir);
    const harness = new FakeHarness({ result: 'heartbeat.selfcheck: ok', costUsd: 0.01 });
    run(['pulse', '--now'], sink(), sink(), { lanternDir, harness });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const out = sink();
    const code = run(['logs', '1'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /Pulse #1/);
    assert.match(out.text, /heartbeat\.selfcheck/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── --agent flag on pulse --now ────────────────────────────────────────

test('lantern pulse --now --agent <id>: fires against the named agent', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pulse-agent-'));
  try {
    initWithCleanWorkdir(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    db.close();

    const harness = new FakeHarness({ result: 'heartbeat.selfcheck: ok', costUsd: 0.01 });
    const out = sink();
    const code = run(['pulse', '--now', '--agent', agent.id], out, sink(), { lanternDir, harness });
    assert.equal(code, 0);
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.match(
      out.text,
      /pulse \d+/,
      '--agent flag should target the named agent and fire a pulse',
    );
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern pulse --now --agent <unknown>: exits 1 with named error', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pulse-agent-unknown-'));
  try {
    initLantern(lanternDir);
    const err = sink();
    const code = run(['pulse', '--now', '--agent', 'no-such-agent'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /unknown agent/);
    assert.match(err.text, /no-such-agent/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern resume leaves paused agent paused ─────────────────────────────

test('lantern resume: leaves a paused agent paused', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-resume-paused-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'paused', 'daemon stopped by operator');
    db.close();

    run(['resume'], sink(), sink(), { lanternDir });

    const check = openDb(join(lanternDir, 'lantern.db'));
    const after = getAgent(check, agent.id);
    check.close();
    assert.equal(after?.state, 'paused', 'resume must not restart an intentionally paused agent');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern inbox ───────────────────────────────────────────────────────────

test('lantern inbox: errors when DB not initialized', () => {
  const err = sink();
  const code = run(['inbox'], sink(), err, { lanternDir: '/nonexistent/lantern-inbox-test' });
  assert.equal(code, 1);
  assert.match(err.text, /not initialized/);
});

test('lantern inbox: shows "no unanswered escalations" when queue is empty', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-empty-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['inbox'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /no unanswered escalations/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern inbox: lists unanswered escalations with severity and question', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-list-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const id = createEscalation(db, {
      agentId: agent.id,
      severity: 'decide',
      question: 'Which branch should ship?',
    });
    db.close();

    const out = sink();
    const code = run(['inbox'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, new RegExp(`#${id}`));
    assert.match(out.text, /\[decide\]/);
    assert.match(out.text, /Which branch should ship\?/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern inbox answer <id> <text>: sets the answer and removes it from the unanswered list', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-answer-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const id = createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'FYI only' });
    db.close();

    const out = sink();
    const code = run(['inbox', 'answer', String(id), 'acknowledged,', 'thanks'], out, sink(), {
      lanternDir,
    });
    assert.equal(code, 0);
    assert.match(out.text, new RegExp(`#${id}`));
    assert.match(out.text, /answered/);

    const check = openDb(join(lanternDir, 'lantern.db'));
    const row = check
      .prepare('SELECT answer, answered_by, answered_at FROM escalations WHERE id = ?')
      .get(id) as { answer: string; answered_by: string; answered_at: string } | undefined;
    check.close();
    assert.equal(row?.answer, 'acknowledged, thanks');
    assert.equal(row?.answered_by, 'human');
    assert.ok(row?.answered_at);

    const out2 = sink();
    run(['inbox'], out2, sink(), { lanternDir });
    assert.match(out2.text, /no unanswered escalations/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern inbox answer: exits 1 with a named error for an unknown id', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-answer-missing-'));
  try {
    initLantern(lanternDir);
    const err = sink();
    const code = run(['inbox', 'answer', '999', 'text'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /not found/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern inbox answer: exits 1 when already answered', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-answer-twice-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const id = createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'q' });
    db.close();

    run(['inbox', 'answer', String(id), 'first'], sink(), sink(), { lanternDir });
    const err = sink();
    const code = run(['inbox', 'answer', String(id), 'second'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /already answered/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern inbox answer: usage error when id or text missing', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-inbox-answer-usage-'));
  try {
    initLantern(lanternDir);
    const err = sink();
    const code = run(['inbox', 'answer'], sink(), err, { lanternDir });
    assert.equal(code, 1);
    assert.match(err.text, /usage/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern inbox approve / reject ─────────────────────────────────────────

function inboxWithEscalation(prefix: string) {
  const lanternDir = mkdtempSync(join(tmpdir(), prefix));
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, lanternDir);
  const id = createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'Release?' });
  db.close();
  const verdictOf = () => {
    const check = openDb(join(lanternDir, 'lantern.db'));
    const row = check
      .prepare('SELECT verdict, answer, answered_at FROM escalations WHERE id = ?')
      .get(id) as { verdict: string | null; answer: string; answered_at: string | null };
    check.close();
    return row;
  };
  return {
    lanternDir,
    id,
    verdictOf,
    cleanup: () => rmSync(lanternDir, { recursive: true, force: true }),
  };
}

test('lantern inbox approve <id> [text]: records an approve verdict', () => {
  const t = inboxWithEscalation('lantern-inbox-approve-');
  try {
    const out = sink();
    assert.equal(
      run(['inbox', 'approve', String(t.id)], out, sink(), { lanternDir: t.lanternDir }),
      0,
    );
    assert.match(out.text, /approved/);
    const row = t.verdictOf();
    assert.equal(row.verdict, 'approve');
    assert.equal(row.answer, 'approved');
    assert.ok(row.answered_at);
  } finally {
    t.cleanup();
  }
});

test('lantern inbox reject <id> <text>: records a reject verdict and requires a reason', () => {
  const t = inboxWithEscalation('lantern-inbox-reject-');
  try {
    const err = sink();
    assert.equal(
      run(['inbox', 'reject', String(t.id)], sink(), err, { lanternDir: t.lanternDir }),
      1,
    );
    assert.match(err.text, /usage/);

    const out = sink();
    const code = run(['inbox', 'reject', String(t.id), 'tests', 'are', 'red'], out, sink(), {
      lanternDir: t.lanternDir,
    });
    assert.equal(code, 0);
    assert.match(out.text, /rejected/);
    assert.deepEqual(
      { v: t.verdictOf().verdict, a: t.verdictOf().answer },
      { v: 'reject', a: 'tests are red' },
    );
  } finally {
    t.cleanup();
  }
});

test('lantern inbox answer: records no verdict', () => {
  const t = inboxWithEscalation('lantern-inbox-plain-');
  try {
    run(['inbox', 'answer', String(t.id), 'noted'], sink(), sink(), { lanternDir: t.lanternDir });
    assert.equal(t.verdictOf().verdict, null);
  } finally {
    t.cleanup();
  }
});

// ── lantern agent add <path> ──────────────────────────────────────────────

test('lantern agent add <path>: registers the agent from its .agent.md and re-add updates it', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-agent-add-'));
  try {
    initLantern(lanternDir);
    const cfgPath = join(lanternDir, 'nina.agent.md');
    const write = (heartbeat: string) =>
      writeFileSync(
        cfgPath,
        `---\nid: nina\ndisplay_name: Nina\nheartbeat: ${heartbeat}\nmax_children: 2\nworkdir: /tmp/nina\n---\n\n## Mission\n\nWatch the fixture.\n`,
      );
    write('15m');
    const out = sink();
    assert.equal(run(['agent', 'add', cfgPath], out, sink(), { lanternDir }), 0);
    assert.match(out.text, /nina/);

    const row = () => {
      const db = openDb(join(lanternDir, 'lantern.db'));
      try {
        return db.prepare('SELECT * FROM agents WHERE id = ?').get('nina') as Record<
          string,
          unknown
        >;
      } finally {
        db.close();
      }
    };
    assert.deepEqual(
      (({
        display_name,
        heartbeat_seconds,
        max_children,
        workdir,
        mission,
        config_path,
        state,
      }) => ({
        display_name,
        heartbeat_seconds,
        max_children,
        workdir,
        mission,
        config_path,
        state,
      }))(row()),
      {
        display_name: 'Nina',
        heartbeat_seconds: 900,
        max_children: 2,
        workdir: '/tmp/nina',
        mission: 'Watch the fixture.',
        config_path: cfgPath,
        state: 'paused',
      },
    );

    write('5m');
    assert.equal(run(['agent', 'add', cfgPath], sink(), sink(), { lanternDir }), 0);
    assert.equal(row().heartbeat_seconds, 300);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern agent add: a bad config exits 1 naming the problem and writes nothing', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-agent-add-bad-'));
  try {
    initLantern(lanternDir);
    const cfgPath = join(lanternDir, 'bad.agent.md');
    writeFileSync(cfgPath, '---\nid: bad\n---\n## Mission\nm\n');
    const err = sink();
    assert.equal(run(['agent', 'add', cfgPath], sink(), err, { lanternDir }), 1);
    assert.match(err.text, /workdir/);
    const db = openDb(join(lanternDir, 'lantern.db'));
    assert.equal((db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n, 0);
    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── the kill switch covers every agent ───────────────────────────

test('lantern pause: kills live sessions of every agent, not only the first', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pause-all-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const first = ensureDefaultAgent(db, lanternDir);
    db.prepare(
      `INSERT INTO agents (id, display_name, config_path, mission, workdir) VALUES ('second', 'Second', 'x', 'm', ?)`,
    ).run(lanternDir);
    createSession(db, { id: 's-first', agentId: first.id, tier: 'read_only' });
    createSession(db, { id: 's-second', agentId: 'second', tier: 'read_only' });
    db.close();

    const out = sink();
    assert.equal(run(['pause'], out, sink(), { lanternDir }), 0);
    assert.match(out.text, /killed 2 session/);
    const db2 = openDb(join(lanternDir, 'lantern.db'));
    const statuses = db2.prepare('SELECT id, status FROM sessions ORDER BY id').all();
    db2.close();
    assert.deepEqual(statuses, [
      { id: 's-first', status: 'killed' },
      { id: 's-second', status: 'killed' },
    ]);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('ensureDefaultAgent: the first-registered agent, deterministically', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-default-agent-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const ins = db.prepare(
      `INSERT INTO agents (id, display_name, config_path, mission, workdir, created_at) VALUES (?, ?, 'x', 'm', '/tmp', ?)`,
    );
    ins.run('zeta', 'Zeta', '2026-09-01 00:00:00');
    ins.run('alpha', 'Alpha', '2026-09-02 00:00:00');
    ins.run('early', 'Early', '2026-08-01 00:00:00');
    assert.equal(ensureDefaultAgent(db, lanternDir).id, 'early');
    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern ui ─────────────────────────────────────────────────────────────

test('lantern ui: not initialized exits 1; a bad port is refused', () => {
  const err = sink();
  assert.equal(run(['ui'], sink(), err, { lanternDir: '/nonexistent/lantern-ui' }), 1);
  assert.match(err.text, /not initialized/);
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-cli-'));
  try {
    initLantern(lanternDir);
    const err2 = sink();
    assert.equal(run(['ui', '--port', 'abc'], sink(), err2, { lanternDir }), 1);
    assert.match(err2.text, /invalid port/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern logs: prints the pulse transcript path when one was saved', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-logs-tr-'));
  try {
    initWithCleanWorkdir(lanternDir);
    const harness = new FakeHarness({ result: 'ok', costUsd: 0.01 });
    run(['pulse', '--now'], sink(), sink(), { lanternDir, harness });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const path = join(lanternDir, 'runs', '1', 'orchestrator.jsonl');
    const none = sink();
    run(['logs', '1'], none, sink(), { lanternDir });
    assert.doesNotMatch(
      none.text,
      /Transcript/,
      'FakeHarness writes none; no line for a missing file',
    );
    mkdirSync(join(lanternDir, 'runs', '1'), { recursive: true });
    writeFileSync(path, '{}\n');
    const out = sink();
    run(['logs', '1'], out, sink(), { lanternDir });
    assert.match(
      out.text,
      new RegExp(`Transcript: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── `lantern pulse --now` is a full tick ─────────────────────────────

test('lantern pulse --now: runs the collect phase for a configured agent, like a daemon tick', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pulse-full-'));
  try {
    initLantern(lanternDir);
    const logs = fileURLToPath(new URL('../test/fixtures/logs.ndjson', import.meta.url));
    const cfg = join(lanternDir, 'c.agent.md');
    writeFileSync(
      cfg,
      `---\nid: c\nworkdir: ${lanternDir}\nallow_dirty: true\nlog_sources:\n  - path: ${logs}\n---\n## Mission\nm\n`,
    );
    assert.equal(run(['agent', 'add', cfg], sink(), sink(), { lanternDir }), 0);
    const harness = new FakeHarness({ result: 'ok', costUsd: 0.01 });
    const out = sink();
    assert.equal(run(['pulse', '--now', '--agent', 'c'], out, sink(), { lanternDir, harness }), 0);
    await new Promise<void>((r) => setTimeout(r, 50));
    assert.match(out.text, /pulse 1 /);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const keys = (
      db.prepare('SELECT action_key FROM pulse_findings WHERE pulse_id = 1').all() as {
        action_key: string;
      }[]
    ).map((r) => r.action_key);
    db.close();
    assert.ok(keys.includes('logs.scan'), `collect phase ran; findings: ${keys.join(', ')}`);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern db ─────────────────────────────────────────────────────────────

test('lantern db: opens sqlite3 on the store; a missing sqlite3 is a named error', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-db-'));
  const saved = process.env.PATH;
  try {
    initLantern(lanternDir);
    const bin = join(lanternDir, 'bin');
    mkdirSync(bin);
    const marker = join(lanternDir, 'sqlite3-args');
    writeFileSync(join(bin, 'sqlite3'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
    chmodSync(join(bin, 'sqlite3'), 0o755);

    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.equal(run(['db'], sink(), sink(), { lanternDir }), 0);
    assert.equal(readFileSync(marker, 'utf8').trim(), join(lanternDir, 'lantern.db'));

    process.env.PATH = '/nonexistent';
    const err = sink();
    assert.equal(run(['db'], sink(), err, { lanternDir }), 1);
    assert.match(err.text, /sqlite3 not found/);

    const err2 = sink();
    assert.equal(run(['db'], sink(), err2, { lanternDir: join(lanternDir, 'nope') }), 1);
    assert.match(err2.text, /not initialized/);
  } finally {
    process.env.PATH = saved;
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── metrics ────────────────────────────────────────────────────────────

test('lantern metrics: prints all six metrics; --days sets the window; status carries them', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-metrics-cli-'));
  try {
    initWithCleanWorkdir(lanternDir);
    run(['pulse', '--now'], sink(), sink(), {
      lanternDir,
      harness: new FakeHarness({ result: 'ok', costUsd: 0.01 }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const out = sink();
    assert.equal(run(['metrics'], out, sink(), { lanternDir }), 0);
    for (const label of [
      'Last 30 days',
      'Pulses run vs. scheduled',
      'Findings per pulse',
      'Collector precision',
      'Observation → ticket → closed',
      'Human touches per closed ticket',
      'Cost per closed ticket',
    ]) {
      assert.ok(out.text.includes(label), `missing: ${label}\n${out.text}`);
    }
    assert.match(out.text, /1 \/ 1 \(100\.0%\)/);

    const week = sink();
    assert.equal(run(['metrics', '--days', '7'], week, sink(), { lanternDir }), 0);
    assert.match(week.text, /Last 7 days/);
    const bad = sink();
    assert.equal(run(['metrics', '--days', 'x'], sink(), bad, { lanternDir }), 1);
    assert.match(bad.text, /--days/);

    const status = sink();
    run(['status'], status, sink(), { lanternDir });
    assert.match(status.text, /Last 30 days/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});
