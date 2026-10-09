import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent, getAgent, setAgentState } from './agent.ts';
import { run } from './cli.ts';
import { daemonLogPath, readDaemonLog } from './daemon-log.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { createRunningPulse, getPulseFindings, recoverOrphanedPulses } from './store/pulses.ts';
import type { Pulse } from './types.ts';

const LANTERN_BIN = fileURLToPath(new URL('../bin/lantern', import.meta.url));

/**
 * Start `lantern start` as a subprocess. Every daemon test goes through here.
 * PATH holds no `claude`, so a tick that passes the gates fails to spawn
 * instead of starting a real, billed turn; the daemon itself is
 * started by absolute node path and needs nothing from PATH.
 */
function spawnDaemon(lanternDir: string): ChildProcess {
  return spawn(process.execPath, [LANTERN_BIN, 'start'], {
    env: {
      ...process.env,
      LANTERN_DIR: lanternDir,
      LANTERN_DISABLE_NOTIFY: '1',
      PATH: '/nonexistent',
    },
  });
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

async function waitForFile(path: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => proc.on('exit', () => resolve()));
}

// ── acceptance tests ──────────────────────────────────────────────────────

test('lantern start: logs startup line to lanternd.log', { timeout: 8000 }, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-'));
  try {
    initLantern(lanternDir);
    const logPath = daemonLogPath(lanternDir);

    const proc = spawnDaemon(lanternDir);

    await waitForFile(logPath);
    const text = readDaemonLog(lanternDir);
    assert.match(text, /lantern daemon started/);
    assert.match(text, /agent="Lantern"/);

    proc.kill('SIGTERM');
    await waitForExit(proc);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern start: sets agent state to stopped after SIGTERM', { timeout: 8000 }, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-'));
  try {
    initLantern(lanternDir);
    const logPath = daemonLogPath(lanternDir);

    const proc = spawnDaemon(lanternDir);

    await waitForFile(logPath);
    proc.kill('SIGTERM');
    await waitForExit(proc);

    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /\[stopped\]/);
    assert.match(out.text, /Lantern/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── lantern status unit tests (no subprocess needed) ─────────────────────────────

test('lantern status: not-initialized exits 1', () => {
  const err = sink();
  const code = run(['status'], sink(), err, { lanternDir: '/nonexistent/lantern-status-test' });
  assert.equal(code, 1);
  assert.match(err.text, /not initialized/);
});

test('lantern status: no agents shows prompt to run lantern start', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-empty-'));
  try {
    initLantern(lanternDir);
    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /no agents/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern status: shows spend / live sessions / unanswered escalations', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-morning-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    ensureDefaultAgent(db, lanternDir);
    db.close();

    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /Spend today:/);
    assert.match(out.text, /\$[\d.]+\s+of\s+\$15\.00 ceiling/);
    assert.match(out.text, /live sessions: 0/);
    assert.match(out.text, /unanswered escalations: 0/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern status: shows agent id, state, heartbeat, last_pulse', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-agent-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'running');
    db.close();

    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /Agents \(1\)/);
    assert.match(out.text, /\[running\]/);
    assert.match(out.text, /heartbeat=3600s/);
    assert.match(out.text, /last_pulse=never/);
    assert.doesNotMatch(out.text, /dead-man/i, 'a brand-new running agent must not warn');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern status: warns when a running agent has gone stale (dead-man alert)', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-deadman-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'running');
    // heartbeat defaults to 3600s; 4h since last pulse is well past the 3x threshold.
    db.prepare(`UPDATE agents SET last_pulse_at = datetime('now', '-4 hours') WHERE id = ?`).run(
      agent.id,
    );
    db.close();

    const out = sink();
    const code = run(['status'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, new RegExp(`⚠ ${agent.id}: no pulse in`));
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern status: no dead-man warning for a paused agent even if stale', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-status-deadman-paused-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'paused', 'operator paused it');
    db.prepare(`UPDATE agents SET last_pulse_at = datetime('now', '-4 hours') WHERE id = ?`).run(
      agent.id,
    );
    db.close();

    const out = sink();
    run(['status'], out, sink(), { lanternDir });
    assert.doesNotMatch(out.text, /dead-man|⚠/i, 'a paused agent is not expected to be pulsing');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── crash recovery ────────────────────────────────────────────────────────

test('recoverOrphanedPulses: marks running pulses error and writes findings', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-recover-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);

    // Create two orphaned running pulses
    const id1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-07T08:00:00.000Z',
      windowEnd: '2026-09-07T09:00:00.000Z',
    });
    const id2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-07T09:00:00.000Z',
      windowEnd: '2026-09-07T10:00:00.000Z',
    });

    const count = recoverOrphanedPulses(db, agent.id);
    assert.equal(count, 2, 'should recover 2 orphaned pulses');

    for (const id of [id1, id2]) {
      const p = db.prepare('SELECT * FROM pulses WHERE id = ?').get(id) as Pulse;
      assert.equal(p.status, 'error');
      assert.match(p.error ?? '', /orphaned/);
      assert.ok(p.ended_at !== null);

      const findings = getPulseFindings(db, id);
      assert.ok(findings.length >= 1, 'orphaned pulse should have a finding');
      assert.equal(findings[0]?.outcome, 'error');
    }

    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('recoverOrphanedPulses: returns 0 when no running pulses', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-recover-noop-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const count = recoverOrphanedPulses(db, agent.id);
    assert.equal(count, 0);
    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern start: recovers orphaned running pulse on startup', { timeout: 8000 }, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-crash-'));
  try {
    initLantern(lanternDir);
    const logPath = daemonLogPath(lanternDir);

    // Plant an orphaned running pulse before the daemon starts
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const orphanId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-07T08:00:00.000Z',
      windowEnd: '2026-09-07T09:00:00.000Z',
    });
    db.close();

    const proc = spawnDaemon(lanternDir);

    // Wait for startup log (recovery happens before this line)
    await waitForFile(logPath);
    proc.kill('SIGTERM');
    await waitForExit(proc);

    const logText = readDaemonLog(lanternDir);
    assert.match(logText, /recovered 1 orphaned/);

    const db2 = openDb(join(lanternDir, 'lantern.db'));
    const orphan = db2.prepare('SELECT * FROM pulses WHERE id = ?').get(orphanId) as Pulse;
    assert.equal(orphan.status, 'error');
    assert.match(orphan.error ?? '', /orphaned/);
    db2.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── PID file + lantern stop ────────────────────────────────────────────────

test('lantern start: writes PID file to lanternDir/<agentId>.pid', { timeout: 8000 }, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pid-write-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    db.close();

    const pidPath = join(lanternDir, `${agent.id}.pid`);
    const proc = spawnDaemon(lanternDir);

    await waitForFile(pidPath);
    const contents = readFileSync(pidPath, 'utf8').trim();
    assert.match(contents, /^\d+$/, 'PID file must contain a numeric PID');

    proc.kill('SIGTERM');
    await waitForExit(proc);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern start: removes PID file on clean SIGTERM shutdown', { timeout: 8000 }, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-pid-clean-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    db.close();

    const pidPath = join(lanternDir, `${agent.id}.pid`);
    const proc = spawnDaemon(lanternDir);

    await waitForFile(pidPath);
    proc.kill('SIGTERM');
    await waitForExit(proc);

    assert.ok(!existsSync(pidPath), 'PID file must be removed on clean SIGTERM shutdown');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern stop: prints no-daemon message when no PID file present', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-stop-nopid-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    ensureDefaultAgent(db, lanternDir);
    db.close();

    const out = sink();
    const code = run(['stop'], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.match(out.text, /no running daemon|no daemon/i);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern stop --agent <id>: removes stale PID file and marks agent paused', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-stop-stale-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'running');
    db.close();

    // Plant a stale PID file (pid 999999999 is almost certainly not running)
    const pidPath = join(lanternDir, `${agent.id}.pid`);
    writeFileSync(pidPath, '999999999');

    const out = sink();
    const code = run(['stop', '--agent', agent.id], out, sink(), { lanternDir });
    assert.equal(code, 0);
    assert.ok(!existsSync(pidPath), 'lantern stop must remove the PID file');

    const check = openDb(join(lanternDir, 'lantern.db'));
    const after = getAgent(check, agent.id);
    check.close();
    assert.equal(after?.state, 'paused', 'lantern stop must mark the agent as paused');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── dead-man alert ────────────────────────────────────────────────────────

test('lantern start: logs a dead-man warning when last_pulse_at is stale by >3x heartbeat', {
  timeout: 8000,
}, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-deadman-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    // heartbeat defaults to 3600s (1h); set last_pulse_at to 4h ago — stale.
    db.prepare(`UPDATE agents SET last_pulse_at = datetime('now', '-4 hours') WHERE id = ?`).run(
      agent.id,
    );
    db.close();

    const logPath = daemonLogPath(lanternDir);
    const proc = spawnDaemon(lanternDir);

    await waitForFile(logPath);
    const text = readDaemonLog(lanternDir);
    assert.match(text, /dead-man check/, 'a stale last_pulse_at must log a dead-man warning');

    proc.kill('SIGTERM');
    await waitForExit(proc);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('lantern start: no dead-man warning for a freshly started agent', {
  timeout: 8000,
}, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-deadman-fresh-'));
  try {
    initLantern(lanternDir);
    const logPath = daemonLogPath(lanternDir);
    const proc = spawnDaemon(lanternDir);

    await waitForFile(logPath);
    const text = readDaemonLog(lanternDir);
    assert.doesNotMatch(
      text,
      /dead-man check/,
      'a brand-new agent must not trip the dead-man alert',
    );

    proc.kill('SIGTERM');
    await waitForExit(proc);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── in-memory agent.state staleness regression ────────────────────────────────
// Found live: `startDaemon` fetches `agent` once, writes 'running' to the DB,
// but onFire's gate check reads the in-memory `agent.state` for the life of
// the process. An agent that was 'paused' (or 'stopped'/'tripped') before
// `lantern start` had every pulse skipped forever, because the snapshot never
// picked up the write.

test('lantern start: an agent paused before start is not gate-skipped on the first tick', {
  timeout: 8000,
}, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-staleness-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, 'paused', 'was paused before this test');
    // Fast heartbeat so a real tick fires within the test window.
    db.prepare('UPDATE agents SET heartbeat_seconds = 1 WHERE id = ?').run(agent.id);
    db.close();

    const logPath = daemonLogPath(lanternDir);
    const proc = spawnDaemon(lanternDir);

    await waitForFile(logPath);
    const deadline = Date.now() + 5000;
    let tickText = '';
    while (Date.now() < deadline) {
      tickText = readDaemonLog(lanternDir);
      if (/tick: window/.test(tickText)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    proc.kill('SIGTERM');
    await waitForExit(proc);

    assert.match(tickText, /tick: window/, 'a tick must have fired within the test window');
    assert.doesNotMatch(
      tickText,
      /pulse skipped — agent state is 'paused'/,
      'agent.state must be updated in-memory right after the DB write, not left as the pre-start snapshot',
    );
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// the gate read the startup snapshot for the life of the process, so a
// trip written to the DB mid-run (Law 7, by enforceDailyCeiling) never reached
// it — and once the UTC day rolled over, gate 2 stopped refusing too.
test('lantern start: a trip written to the DB while running is honoured on the next tick', {
  timeout: 8000,
}, async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-trip-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    db.prepare('UPDATE agents SET heartbeat_seconds = 1 WHERE id = ?').run(agent.id);
    db.close();

    const logPath = daemonLogPath(lanternDir);
    const proc = spawnDaemon(lanternDir);

    // The log exists only after startup wrote state='running'; the first tick
    // is ≥0.9s away, so this trip lands between the two.
    await waitForFile(logPath);
    const db2 = openDb(join(lanternDir, 'lantern.db'));
    setAgentState(db2, agent.id, 'tripped', 'daily budget breached (test)');
    db2.close();

    const deadline = Date.now() + 5000;
    let text = '';
    while (Date.now() < deadline) {
      text = readDaemonLog(lanternDir);
      if (/pulse skipped|gates passed/.test(text)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    proc.kill('SIGTERM');
    await waitForExit(proc);

    assert.match(text, /pulse skipped — agent state is 'tripped'/);
    assert.doesNotMatch(text, /gates passed/);
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── gates read the agent config on each tick ───────────────────────────

async function tickWithConfig(front: string, seed?: (db: ReturnType<typeof openDb>) => void) {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-cfg-'));
  initLantern(lanternDir);
  const workdir = join(lanternDir, 'work'); // exists, not a git repo
  mkdirSync(workdir);
  const cfg = join(lanternDir, 'cfg.agent.md');
  writeFileSync(
    cfg,
    `---\nid: cfg\nheartbeat: 1s\nworkdir: ${workdir}\n${front}\n---\n## Mission\nm\n`,
  );
  assert.equal(run(['agent', 'add', cfg], sink(), sink(), { lanternDir }), 0);
  if (seed) {
    const db = openDb(join(lanternDir, 'lantern.db'));
    seed(db);
    db.close();
  }
  const logPath = daemonLogPath(lanternDir);
  const proc = spawnDaemon(lanternDir);
  await waitForFile(logPath);
  let text = '';
  for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
    text = readDaemonLog(lanternDir);
    if (/pulse skipped|gates passed/.test(text)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGTERM');
  await waitForExit(proc);
  rmSync(lanternDir, { recursive: true, force: true });
  return text;
}

test('lantern start: gate 2 uses budget.per_day_usd from the agent config', {
  timeout: 10000,
}, async () => {
  const text = await tickWithConfig('allow_dirty: true\nbudget:\n  per_day_usd: 0.50', (db) => {
    db.prepare('INSERT INTO usage_daily (day, cost_usd) VALUES (?, 1.0)').run(
      new Date().toISOString().slice(0, 10),
    );
  });
  assert.match(text, /pulse skipped — daily spend \$1\.00 meets or exceeds ceiling \$0\.50/);
});

test('lantern start: gate 5 is on unless the config sets allow_dirty', {
  timeout: 10000,
}, async () => {
  const text = await tickWithConfig('');
  assert.match(text, /pulse skipped — could not check working tree/);
});

// ── SIGTERM never overwrites a state someone else chose ────────────────
// `lantern stop` writes 'paused' and SIGTERMs the daemon, whose handler wrote
// 'stopped' — whichever landed last won. The handler now only moves
// running → stopped.

async function sigtermAfter(state: 'paused' | 'tripped'): Promise<string | undefined> {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-daemon-sigterm-'));
  try {
    initLantern(lanternDir);
    const proc = spawnDaemon(lanternDir);
    await waitForFile(daemonLogPath(lanternDir));
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    setAgentState(db, agent.id, state, 'set while the daemon runs');
    db.close();
    proc.kill('SIGTERM');
    await waitForExit(proc);
    const db2 = openDb(join(lanternDir, 'lantern.db'));
    const after = getAgent(db2, agent.id)?.state;
    db2.close();
    return after;
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('lantern start: SIGTERM after `lantern stop` wrote paused leaves it paused', {
  timeout: 8000,
}, async () => {
  assert.equal(await sigtermAfter('paused'), 'paused');
});

test('lantern start: SIGTERM does not clear a Law 7 trip', { timeout: 8000 }, async () => {
  assert.equal(await sigtermAfter('tripped'), 'tripped');
});

// ── a Law 7 trip survives `lantern start` ────────────────────────────
// startDaemon set state='running' unconditionally, so restarting the daemon
// silently untripped a budget breach that Law 7 says needs `lantern resume`.

async function startTripped(extraArgs: string[]) {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-start-tripped-'));
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, lanternDir);
  setAgentState(db, agent.id, 'tripped', 'daily budget breached (test)');
  db.close();
  const proc = spawn(process.execPath, [LANTERN_BIN, 'start', ...extraArgs], {
    env: {
      ...process.env,
      LANTERN_DIR: lanternDir,
      LANTERN_DISABLE_NOTIFY: '1',
      PATH: '/nonexistent',
    },
  });
  let stderr = '';
  proc.stderr?.on('data', (c) => {
    stderr += c;
  });
  // A start that wrongly proceeds runs forever; kill it after 3s so the test fails instead of hanging.
  const killer = setTimeout(() => proc.kill('SIGKILL'), 3000);
  const code = await new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
  clearTimeout(killer);
  await new Promise((r) => setTimeout(r, 500)); // let a wrongly detached child write its PID file
  const pidPath = join(lanternDir, `${agent.id}.pid`);
  const spawned = existsSync(pidPath);
  if (spawned) process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL');
  const db2 = openDb(join(lanternDir, 'lantern.db'));
  const state = getAgent(db2, agent.id)?.state;
  db2.close();
  rmSync(lanternDir, { recursive: true, force: true });
  return { code, stderr, spawned, state };
}

test('lantern start: refuses a tripped agent and names lantern resume', {
  timeout: 10000,
}, async () => {
  const r = await startTripped([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tripped.*lantern resume/);
  assert.equal(r.spawned, false);
  assert.equal(r.state, 'tripped');
});

test('lantern start --daemon: refuses a tripped agent before detaching anything', {
  timeout: 10000,
}, async () => {
  const r = await startTripped(['--daemon']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tripped.*lantern resume/);
  assert.equal(r.spawned, false, 'no detached daemon');
  assert.equal(r.state, 'tripped');
});
