import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentRunning,
  inboxAnswer,
  inboxVerdict,
  killSessionAction,
  pause,
  pulseNow,
  registerAgent,
  resume,
  startAgent,
  stopAgent,
  triageAccept,
  triageDismiss,
} from './actions.ts';
import { ensureDefaultAgent, getAgent, setAgentState } from './agent.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { createEscalation, getEscalation } from './store/escalations.ts';
import { createSession, getSession } from './store/sessions.ts';
import { createTicket, getTicket } from './store/tickets.ts';

function setup() {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-actions-'));
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, lanternDir);
  return {
    lanternDir,
    db,
    agent,
    cleanup: () => {
      db.close();
      rmSync(lanternDir, { recursive: true, force: true });
    },
  };
}

const ticket = (db: ReturnType<typeof openDb>, needsTriage = true) =>
  createTicket(
    db,
    { kind: 'bug', title: 't', body: 'b', origin: 'collector:logs', needs_triage: needsTriage },
    { actor: 'test' },
  );

// ── triage ────────────────────────────────────────────────────────────────────

test('triageAccept: clears needs_triage; refuses unknown, non-triage and bad ids', () => {
  const { db, cleanup } = setup();
  try {
    const id = ticket(db);
    assert.deepEqual(triageAccept(db, id), {
      ok: true,
      messages: [`ticket #${id} accepted — cleared needs_triage, open for staffing`],
    });
    assert.equal(getTicket(db, id)?.needs_triage, 0);
    assert.deepEqual(triageAccept(db, id), { ok: false, error: `#${id} does not need triage` });
    assert.deepEqual(triageAccept(db, 999), { ok: false, error: '#999 not found' });
    assert.deepEqual(triageAccept(db, 1.5), { ok: false, error: "invalid id '1.5'" });
  } finally {
    cleanup();
  }
});

test('triageDismiss: closes as wontfix with the reason; a reason is required', () => {
  const { db, cleanup } = setup();
  try {
    const id = ticket(db);
    assert.deepEqual(triageDismiss(db, id, '  '), { ok: false, error: 'a reason is required' });
    assert.deepEqual(triageDismiss(db, id, 'known flake'), {
      ok: true,
      messages: [`ticket #${id} dismissed as wontfix`],
    });
    const t = getTicket(db, id);
    assert.equal(t?.status, 'wontfix');
    assert.equal(t?.resolution, 'known flake');
  } finally {
    cleanup();
  }
});

// ── inbox ─────────────────────────────────────────────────────────────────────

test('inboxAnswer / inboxVerdict: record the answer and verdict; reject needs a reason', () => {
  const { db, agent, cleanup } = setup();
  try {
    const ask = () =>
      createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'q?' });
    const a = ask();
    assert.deepEqual(inboxAnswer(db, a, ''), { ok: false, error: 'an answer is required' });
    assert.deepEqual(inboxAnswer(db, a, 'noted'), {
      ok: true,
      messages: [`escalation #${a} answered`],
    });
    assert.equal(getEscalation(db, a)?.verdict, null);
    assert.match((inboxAnswer(db, a, 'again') as { error: string }).error, /already answered/);

    const b = ask();
    assert.deepEqual(inboxVerdict(db, b, 'approve'), {
      ok: true,
      messages: [`escalation #${b} approved`],
    });
    assert.equal(getEscalation(db, b)?.verdict, 'approve');
    assert.equal(getEscalation(db, b)?.answer, 'approved');

    const c = ask();
    assert.deepEqual(inboxVerdict(db, c, 'reject'), {
      ok: false,
      error: 'a reason is required to reject',
    });
    assert.deepEqual(inboxVerdict(db, c, 'reject', 'tests red'), {
      ok: true,
      messages: [`escalation #${c} rejected`],
    });
    assert.equal(getEscalation(db, c)?.verdict, 'reject');
  } finally {
    cleanup();
  }
});

// ── kill switch ───────────────────────────────────────────────────────────────

test('pause writes PAUSED and kills every live session; resume clears it and untrips', () => {
  const { lanternDir, db, agent, cleanup } = setup();
  try {
    createSession(db, { id: 's1', agentId: agent.id, tier: 'read_only' });
    const p = pause(db, lanternDir);
    assert.deepEqual(p, {
      ok: true,
      messages: ['daemon paused — pulses blocked until `lantern resume` (killed 1 session(s))'],
    });
    assert.ok(existsSync(join(lanternDir, 'PAUSED')));
    assert.equal(getSession(db, 's1')?.status, 'killed');

    setAgentState(db, agent.id, 'tripped', 'budget');
    assert.deepEqual(resume(db, lanternDir), {
      ok: true,
      messages: [
        'kill switch cleared — pulses re-enabled',
        `agent ${agent.id} (was tripped: budget) → running`,
      ],
    });
    assert.ok(!existsSync(join(lanternDir, 'PAUSED')));
    assert.equal(getAgent(db, agent.id)?.state, 'running');
    assert.deepEqual(resume(db, lanternDir), { ok: true, messages: ['nothing to resume'] });
  } finally {
    cleanup();
  }
});

test('killSessionAction: kills a live session; refuses unknown and finished ones', () => {
  const { db, agent, cleanup } = setup();
  try {
    createSession(db, { id: 'k1', agentId: agent.id, tier: 'read_only' });
    assert.deepEqual(killSessionAction(db, 'nope'), {
      ok: false,
      error: "session 'nope' not found",
    });
    assert.deepEqual(killSessionAction(db, 'k1'), { ok: true, messages: ['session k1 killed'] });
    // No in-process handle and no pid: the row must still say killed. The CLI
    // used to report "killed" and leave the row live.
    assert.equal(getSession(db, 'k1')?.status, 'killed');
    assert.deepEqual(killSessionAction(db, 'k1'), {
      ok: false,
      error: 'session k1 is already killed',
    });
  } finally {
    cleanup();
  }
});

// ── running Lantern ────────────────────────────────────────────────────────

/** A launcher that records what it would have run, and spawns nothing. */
function fakeLauncher() {
  const calls: string[][] = [];
  const launch = (args: string[]) => {
    calls.push(args);
    return 4242;
  };
  return { calls, launch };
}

test('startAgent: launches a detached daemon; refuses unknown, tripped and already-running agents', () => {
  const { lanternDir, db, agent, cleanup } = setup();
  try {
    const l = fakeLauncher();
    assert.deepEqual(startAgent(db, lanternDir, 'nope', l.launch), {
      ok: false,
      error: "agent 'nope' not found",
    });

    setAgentState(db, agent.id, 'tripped', 'budget');
    const tripped = startAgent(db, lanternDir, agent.id, l.launch);
    assert.equal(tripped.ok, false);
    assert.match((tripped as { error: string }).error, /tripped.*lantern resume/);

    setAgentState(db, agent.id, 'paused');
    assert.deepEqual(startAgent(db, lanternDir, agent.id, l.launch), {
      ok: true,
      messages: [
        `agent ${agent.id} starting (pid 4242), logging to ${join(lanternDir, 'logs', 'lanternd.log')}`,
      ],
    });
    assert.deepEqual(l.calls, [['start', '--agent', agent.id]]);

    // A live PID file means it is already running: this process's own pid is live.
    writeFileSync(join(lanternDir, `${agent.id}.pid`), String(process.pid));
    assert.deepEqual(startAgent(db, lanternDir, agent.id, l.launch), {
      ok: false,
      error: `agent ${agent.id} is already running (pid ${process.pid})`,
    });
    assert.equal(l.calls.length, 1, 'no second launch');
  } finally {
    cleanup();
  }
});

test('stopAgent: signals the PID file, removes it, marks paused; says so when nothing runs', async () => {
  const { lanternDir, db, agent, cleanup } = setup();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    assert.deepEqual(stopAgent(db, lanternDir, agent.id), {
      ok: true,
      messages: [`no running daemon found for agent '${agent.id}'`],
    });
    writeFileSync(join(lanternDir, `${agent.id}.pid`), String(sleeper.pid));
    const exited = new Promise((r) => sleeper.on('exit', (_c, sig) => r(sig)));
    assert.deepEqual(stopAgent(db, lanternDir, agent.id), {
      ok: true,
      messages: [`sent SIGTERM to ${agent.display_name} daemon (pid ${sleeper.pid})`],
    });
    assert.equal(await exited, 'SIGTERM');
    assert.ok(!existsSync(join(lanternDir, `${agent.id}.pid`)));
    assert.equal(getAgent(db, agent.id)?.state, 'paused');
    assert.deepEqual(stopAgent(db, lanternDir, 'nope'), {
      ok: false,
      error: "agent 'nope' not found",
    });
  } finally {
    sleeper.kill('SIGKILL');
    cleanup();
  }
});

test('agentRunning: a PID file counts only while its process is alive', () => {
  const { lanternDir, agent, cleanup } = setup();
  try {
    assert.deepEqual(agentRunning(lanternDir, agent.id), { running: false, pid: null });
    writeFileSync(join(lanternDir, `${agent.id}.pid`), String(process.pid));
    assert.deepEqual(agentRunning(lanternDir, agent.id), { running: true, pid: process.pid });
    writeFileSync(join(lanternDir, `${agent.id}.pid`), '999999');
    assert.deepEqual(agentRunning(lanternDir, agent.id), { running: false, pid: 999999 });
  } finally {
    cleanup();
  }
});

test('registerAgent: upserts from a valid .agent.md; a bad one is refused naming the field', () => {
  const { lanternDir, db, cleanup } = setup();
  try {
    const good = join(lanternDir, 'g.agent.md');
    writeFileSync(good, '---\nid: g\nworkdir: /tmp/g\nheartbeat: 15m\n---\n## Mission\nm\n');
    const r = registerAgent(db, good);
    assert.equal(r.ok, true);
    assert.match((r as { messages: string[] }).messages[0] ?? '', /agent g registered/);
    assert.equal(getAgent(db, 'g')?.heartbeat_seconds, 900);

    const bad = join(lanternDir, 'b.agent.md');
    writeFileSync(bad, '---\nid: b\n---\n## Mission\nm\n');
    assert.match((registerAgent(db, bad) as { error: string }).error, /workdir/);
    assert.match(
      (registerAgent(db, '/nonexistent/x.agent.md') as { error: string }).error,
      /no such file|ENOENT/i,
    );
    assert.match((registerAgent(db, 'relative.agent.md') as { error: string }).error, /absolute/);
  } finally {
    cleanup();
  }
});

test('pulseNow: launches `lantern pulse --now --agent <id>`; refuses unknown and tripped agents', () => {
  const { lanternDir, db, agent, cleanup } = setup();
  try {
    const l = fakeLauncher();
    assert.equal(pulseNow(db, lanternDir, 'nope', l.launch).ok, false);
    assert.equal(pulseNow(db, lanternDir, agent.id, l.launch).ok, true);
    assert.deepEqual(l.calls, [['pulse', '--now', '--agent', agent.id]]);
    setAgentState(db, agent.id, 'tripped', 'budget');
    assert.match(
      (pulseNow(db, lanternDir, agent.id, l.launch) as { error: string }).error,
      /tripped/,
    );
  } finally {
    cleanup();
  }
});
