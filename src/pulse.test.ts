import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeHarness } from '../test/support/fake-harness.ts';
import { getAgent, setAgentState, upsertAgentFromConfig } from './agent.ts';
import { loadAgentConfig } from './agent-config.ts';
import { openDb } from './db.ts';
import { waitForCompletions } from './harness/session-runner.ts';
import { initLantern } from './init.ts';
import { runPulse } from './pulse.ts';
import { getPulseFindings } from './store/pulses.ts';
import { getSession } from './store/sessions.ts';

const LOGS = fileURLToPath(new URL('../test/fixtures/logs.ndjson', import.meta.url));
const WINDOW = { window_start: '2026-09-07T00:00:00.000Z', window_end: '2026-09-08T00:00:00.000Z' };

/** A registered agent with a log source, `allow_dirty` so the temp workdir passes gate 5. */
function setup() {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-runpulse-'));
  initLantern(lanternDir);
  const cfg = join(lanternDir, 'p.agent.md');
  writeFileSync(
    cfg,
    `---\nid: p\nworkdir: ${lanternDir}\nallow_dirty: true\nlog_sources:\n  - path: ${LOGS}\n---\n## Mission\nm\n`,
  );
  const db = openDb(join(lanternDir, 'lantern.db'));
  upsertAgentFromConfig(db, loadAgentConfig(cfg), cfg);
  return {
    lanternDir,
    db,
    cleanup: () => {
      db.close();
      rmSync(lanternDir, { recursive: true, force: true });
    },
  };
}

test('runPulse (manual): collect phase, turn and reap — a paused agent still pulses', async () => {
  const { lanternDir, db, cleanup } = setup();
  try {
    // Paused (no daemon) is exactly when someone presses Pulse now.
    assert.equal(getAgent(db, 'p')?.state, 'paused');
    db.prepare(`INSERT INTO sessions (id, agent_id, tier) VALUES ('q1', 'p', 'read_only')`).run();

    const harness = new FakeHarness({ result: 'ok', costUsd: 0.02 });
    const child = new FakeHarness({ result: 'child done', costUsd: 0.01 });
    const out = await runPulse({
      db,
      lanternDir,
      agentId: 'p',
      window: WINDOW,
      manual: true,
      harness,
      childHarness: child,
    });
    assert.equal(out.kind, 'ran');
    await waitForCompletions();

    const findings = getPulseFindings(db, out.pulseId);
    const logs = findings.find((f) => f.action_key === 'logs.scan');
    assert.ok(logs, 'the collect phase scanned the configured log — no playbook_run needed');
    assert.equal(harness.callCount(), 1, 'one orchestrator turn');
    assert.equal(child.callCount(), 1, 'reap started the queued child');
    assert.equal(getSession(db, 'q1')?.status, 'done', 'and recorded its completion');
  } finally {
    cleanup();
  }
});

test('runPulse (manual): a tripped agent is refused with a skipped pulse row', async () => {
  const { lanternDir, db, cleanup } = setup();
  try {
    setAgentState(db, 'p', 'tripped', 'budget');
    const harness = new FakeHarness();
    const out = await runPulse({
      db,
      lanternDir,
      agentId: 'p',
      window: WINDOW,
      manual: true,
      harness,
    });
    assert.equal(out.kind, 'skipped');
    assert.match((out as { reason: string }).reason, /tripped/);
    assert.equal(harness.callCount(), 0);
    const row = db.prepare('SELECT status, error FROM pulses WHERE id = ?').get(out.pulseId) as {
      status: string;
      error: string;
    };
    assert.equal(row.status, 'skipped');
  } finally {
    cleanup();
  }
});

test('runPulse (tick): a paused agent is skipped, as the daemon always did', async () => {
  const { lanternDir, db, cleanup } = setup();
  try {
    const out = await runPulse({
      db,
      lanternDir,
      agentId: 'p',
      window: WINDOW,
      harness: new FakeHarness(),
    });
    assert.equal(out.kind, 'skipped');
    assert.match((out as { reason: string }).reason, /agent state is 'paused'/);
  } finally {
    cleanup();
  }
});

test('runPulse: a collector that throws closes the pulse as error instead of leaving it running', async () => {
  const { lanternDir, db, cleanup } = setup();
  try {
    // A log source that is a directory makes the reader throw.
    const cfg = join(lanternDir, 'p.agent.md');
    writeFileSync(
      cfg,
      `---\nid: p\nworkdir: ${lanternDir}\nallow_dirty: true\nlog_sources:\n  - path: ${lanternDir}\n    format: plain\n---\n## Mission\nm\n`,
    );
    const out = await runPulse({
      db,
      lanternDir,
      agentId: 'p',
      window: WINDOW,
      manual: true,
      harness: new FakeHarness(),
    });
    assert.equal(out.kind, 'error');
    const row = db.prepare('SELECT status FROM pulses WHERE id = ?').get(out.pulseId) as {
      status: string;
    };
    assert.equal(row.status, 'error', 'gate 6 must not be held shut by a stuck running row');
  } finally {
    cleanup();
  }
});

test('runPulse: an agent with ci_watch runs it in the collect phase, before the turn', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-runpulse-ci-'));
  try {
    initLantern(lanternDir);
    const repo = join(lanternDir, 'repo');
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    writeFileSync(
      join(repo, 'run-tests.sh'),
      'mkdir -p out\necho \'<testsuite name="S"><testcase classname="S" name="ok"/></testsuite>\' > out/TEST-s.xml\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, env });
    const cfg = join(lanternDir, 'ci.agent.md');
    writeFileSync(
      cfg,
      `---\nid: ci\nworkdir: ${repo}\ntest_commands:\n  - sh run-tests.sh\nci_watch:\n  command: sh run-tests.sh\n  reports: out/*.xml\n---\n## Mission\nm\n`,
    );
    const db = openDb(join(lanternDir, 'lantern.db'));
    upsertAgentFromConfig(db, loadAgentConfig(cfg), cfg);
    let seenBeforeTurn = '';
    const harness = new FakeHarness({
      result: 'ok',
      onRun: () => {
        seenBeforeTurn =
          (
            db.prepare(`SELECT detail FROM pulse_findings WHERE action_key = 'ci.watch'`).get() as
              | { detail: string }
              | undefined
          )?.detail ?? '';
      },
    });
    const out = await runPulse({
      db,
      lanternDir,
      agentId: 'ci',
      window: WINDOW,
      manual: true,
      harness,
    });
    assert.equal(out.kind, 'ran');
    assert.match(seenBeforeTurn, /1 tests passed/, 'the turn sees the ci.watch finding');
    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── No Claude turn when nothing changed ────────────────────
// Idle PetClinic pulses cost $0.10–0.16 each: ~$12/day at a 15-minute
// heartbeat, past the $5 default ceiling with nothing to do.

const QUIET = { window_start: '2020-01-01T00:00:00.000Z', window_end: '2020-01-01T00:05:00.000Z' };

test('runPulse: nothing new since the last turn → no Claude turn, $0, the health check still recorded', async () => {
  const { lanternDir, db, cleanup } = setup();
  setAgentState(db, 'p', 'running'); // a daemon tick, not Pulse now
  try {
    const harness = new FakeHarness({ result: 'ok', costUsd: 0.12 });
    const first = await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(first.kind, 'ran');
    assert.equal(harness.callCount(), 1, 'the first pulse always has a turn');

    const second = await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(second.kind === 'ran' && second.costUsd, 0);
    assert.equal(harness.callCount(), 1, 'no second turn');
    const row = db
      .prepare('SELECT status, summary, cost_usd FROM pulses WHERE id = ?')
      .get(second.pulseId) as {
      status: string;
      summary: string;
      cost_usd: number;
    };
    assert.equal(row.status, 'clean');
    assert.match(row.summary, /^no turn — nothing new since pulse #\d+/);
    const self = getPulseFindings(db, second.pulseId).find(
      (f) => f.action_key === 'heartbeat.selfcheck',
    );
    assert.equal(self?.outcome, 'clean');

    // A human comment is news: the next pulse takes a turn.
    const t = db
      .prepare(`INSERT INTO tickets (kind, title, body, origin) VALUES ('bug', 't', 'b', 'human')`)
      .run();
    db.prepare(
      `INSERT INTO ticket_events (ticket_id, actor, event, payload, created_at) VALUES (?, 'human', 'commented', '{"body":"fix it"}', datetime('now', '+1 second'))`,
    ).run(t.lastInsertRowid);
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(harness.callCount(), 2, 'a human comment brings a turn');

    // A manual Pulse now always takes a turn.
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, manual: true, harness });
    assert.equal(harness.callCount(), 3);

    // No turn for 2 hours: a periodic turn even with nothing new.
    db.prepare(
      `UPDATE pulses SET ended_at = datetime('now', '-3 hours'), started_at = datetime('now', '-3 hours')`,
    ).run();
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(harness.callCount(), 4, 'a periodic turn after 2 h');
  } finally {
    cleanup();
  }
});

test('runPulse: a newly filed ticket or a finished child brings a turn', async () => {
  const { lanternDir, db, cleanup } = setup();
  setAgentState(db, 'p', 'running'); // a daemon tick, not Pulse now
  try {
    const harness = new FakeHarness({ result: 'ok', costUsd: 0.1 });
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    // The log fixture's window files tickets → news.
    await runPulse({ db, lanternDir, agentId: 'p', window: WINDOW, harness });
    assert.equal(harness.callCount(), 2, 'new tickets this pulse');
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(harness.callCount(), 2, 'then quiet again');
    // A child finishing writes its completed event (actor = the agent).
    db.prepare(
      `INSERT INTO sessions (id, agent_id, tier, status) VALUES ('s1', 'p', 'read_only', 'done')`,
    ).run();
    const tk = (db.prepare('SELECT id FROM tickets LIMIT 1').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO ticket_events (ticket_id, actor, event, payload, session_id, created_at) VALUES (?, 'p', 'completed', '{}', 's1', datetime('now', '+1 second'))`,
    ).run(tk);
    await runPulse({ db, lanternDir, agentId: 'p', window: QUIET, harness });
    assert.equal(harness.callCount(), 3, 'a finished child is news');
  } finally {
    cleanup();
  }
});
