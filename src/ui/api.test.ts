import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent, upsertAgentFromConfig } from '../agent.ts';
import { loadAgentConfig } from '../agent-config.ts';
import { ticketCiRun } from '../collectors/ci-ticketing.ts';
import { bugEvidence } from '../collectors/inbox-bugs.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { recordRun } from '../store/ci.ts';
import { createEscalation, getEscalation } from '../store/escalations.ts';
import { createLink } from '../store/links.ts';
import {
  createRunningPulse,
  createSkippedPulse,
  finishPulse,
  writePulseFinding,
} from '../store/pulses.ts';
import { createSession, getSession } from '../store/sessions.ts';
import { createTicket, getTicket, getTicketEvents } from '../store/tickets.ts';
import { startUiServer, type UiServer } from './server.ts';

// Test-side view of a JSON response: loose on purpose, each test asserts the fields it reads.
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field below
type Json = any;

const HOSTILE = '<img src=x onerror="fetch(\'/api/inbox\')">';

/** A Lantern dir with one of everything the views show. */
function seed(lanternDir: string) {
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, lanternDir);
  const bug = createTicket(
    db,
    {
      kind: 'bug',
      title: HOSTILE,
      body: 'from a log line',
      origin: 'collector:logs',
      needs_triage: true,
    },
    { actor: 'test' },
  );
  const task = createTicket(
    db,
    { kind: 'chore', title: 'Rotate keys', body: 'b', origin: 'human', priority: 'p1' },
    { actor: 'test' },
  );
  createLink(db, { from_ticket: task, to_ticket: bug, rel: 'relates_to', note: null });
  const esc = createEscalation(db, {
    agentId: agent.id,
    ticketId: task,
    severity: 'blocking',
    question: 'Rotate in prod?',
    options: ['yes', 'no'],
  });
  const pulseId = createRunningPulse(db, { agentId: agent.id, windowStart: 'a', windowEnd: 'b' });
  writePulseFinding(db, { pulseId, actionKey: 'logs.scan', outcome: 'finding', ticketId: bug });
  finishPulse(db, pulseId, { status: 'acted', summary: 'filed one', costUsd: 0.12 });
  createSession(db, { id: 'sess-1', agentId: agent.id, tier: 'read_only', ticketId: task });
  db.close();
  return { agent, bug, task, esc, pulseId };
}

async function withApi(
  fn: (
    get: (p: string) => Promise<{ status: number; body: Json }>,
    ids: ReturnType<typeof seed>,
  ) => Promise<void>,
) {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-api-'));
  const ids = seed(lanternDir);
  const ui: UiServer = await startUiServer({ lanternDir, port: 0, token: 't' });
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
      headers: { 'x-lantern-token': 't' },
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    await fn(get, ids);
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('GET /api/status: agents with dead-man and ceiling, kill switch, spend, counts', async () => {
  await withApi(async (get, ids) => {
    const { status, body } = await get('status');
    assert.equal(status, 200);
    assert.equal(body.paused, false);
    assert.equal(body.agents.length, 1);
    const a = body.agents[0];
    assert.equal(a.id, ids.agent.id);
    assert.equal(typeof a.deadman.stale, 'boolean');
    assert.equal(a.dailyCeilingUsd, 15);
    assert.equal(body.spend.cost_usd, 0.12);
    assert.equal(body.liveSessions, 0, 'a queued session is not a live child');
    assert.equal(body.queuedSessions, 1);
    assert.equal(body.unanswered, 1);
    assert.equal(body.needsTriage, 1, 'the sidebar count');
    assert.equal(body.precision, undefined, 'precision lives in /api/metrics');
  });
});

test('GET /api/inbox: unanswered escalations with their ticket title and options', async () => {
  await withApi(async (get, ids) => {
    const { body } = await get('inbox');
    assert.equal(body.length, 1);
    assert.equal(body[0].id, ids.esc);
    assert.equal(body[0].severity, 'blocking');
    assert.equal(body[0].ticket_title, 'Rotate keys');
    assert.deepEqual(body[0].options, ['yes', 'no']);
  });
});

test('GET /api/triage: needs_triage tickets — collected text comes back as plain data', async () => {
  await withApi(async (get, ids) => {
    const { body } = await get('triage');
    assert.equal(body.length, 1);
    assert.equal(body[0].id, ids.bug);
    assert.equal(body[0].origin, 'collector:logs');
    assert.equal(
      body[0].title,
      HOSTILE,
      'returned verbatim as a JSON string; the page renders it as text',
    );
  });
});

test('GET /api/tickets: list, status filter, search; /tickets/:id has events and links', async () => {
  await withApi(async (get, ids) => {
    assert.equal((await get('tickets')).body.length, 2);
    assert.deepEqual(
      (await get('tickets?status=open')).body.map((t: { id: number }) => t.id).sort(),
      [ids.bug, ids.task].sort(),
    );
    const hits = (await get('tickets?search=rotate%20keys')).body;
    assert.equal(hits[0]?.id, ids.task);

    const one = await get(`tickets/${ids.task}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.ticket.title, 'Rotate keys');
    assert.ok(one.body.events.some((e: { event: string }) => e.event === 'created'));
    assert.equal(one.body.links[0].rel, 'relates_to');

    assert.equal((await get('tickets/999')).status, 404);
    assert.equal((await get('tickets/abc')).status, 400);
    assert.equal((await get('tickets?status=bogus')).status, 400);
  });
});

test('GET /api/sessions: all, or ?live=1', async () => {
  await withApi(async (get) => {
    const all = (await get('sessions')).body;
    assert.equal(all[0].id, 'sess-1');
    assert.equal((await get('sessions?live=1')).body.length, 1);
  });
});

test('GET /api/pulses: last 24h with findings; /pulses/:id has findings and sessions', async () => {
  await withApi(async (get, ids) => {
    const list = (await get('pulses')).body;
    assert.equal(list[0].id, ids.pulseId);
    assert.equal(list[0].status, 'acted');
    assert.equal(list[0].findings[0].action_key, 'logs.scan');

    const one = (await get(`pulses/${ids.pulseId}`)).body;
    assert.equal(one.pulse.summary, 'filed one');
    assert.equal(one.findings[0].ticket_id, ids.bug);
    assert.ok(Array.isArray(one.sessions));
    assert.equal((await get('pulses/999')).status, 404);
  });
});

// ── actions ──────────────────────────────────────────────────────────────

async function withActions(
  fn: (
    post: (p: string, body?: object) => Promise<{ status: number; body: Json }>,
    db: ReturnType<typeof openDb>,
    ids: ReturnType<typeof seed>,
    lanternDir: string,
  ) => Promise<void>,
) {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-act-'));
  const ids = seed(lanternDir);
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  const post = async (p: string, body: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
      method: 'POST',
      headers: {
        'x-lantern-token': 't',
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${ui.port}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const db = openDb(join(lanternDir, 'lantern.db'));
  try {
    await fn(post, db, ids, lanternDir);
  } finally {
    db.close();
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('POST inbox: approve records the verdict; a second answer is 409; reject needs a reason', async () => {
  await withActions(async (post, db, ids) => {
    const r = await post(`inbox/${ids.esc}/approve`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages, [`escalation #${ids.esc} approved`]);
    assert.equal(getEscalation(db, ids.esc)?.verdict, 'approve');
    assert.equal((await post(`inbox/${ids.esc}/answer`, { text: 'again' })).status, 409);

    const other = createEscalation(db, {
      agentId: ids.agent.id,
      severity: 'decide',
      question: 'q',
    });
    assert.equal((await post(`inbox/${other}/reject`, {})).status, 400);
    assert.equal((await post(`inbox/${other}/reject`, { text: 'no' })).status, 200);
    assert.equal(getEscalation(db, other)?.verdict, 'reject');

    const third = createEscalation(db, { agentId: ids.agent.id, severity: 'fyi', question: 'q' });
    assert.equal((await post(`inbox/${third}/answer`, { text: 'noted' })).status, 200);
    assert.equal(getEscalation(db, third)?.verdict, null, 'a plain answer never approves');

    assert.equal((await post('inbox/999/approve')).status, 404);
    assert.equal((await post(`inbox/${third}/delete`)).status, 404);
    assert.equal((await post('inbox/abc/approve')).status, 400);
    assert.equal(
      (await post(`inbox/${third}/answer`, { text: 42 })).status,
      400,
      'non-string text',
    );
  });
});

test('POST triage: accept clears the flag; dismiss closes as wontfix with the reason', async () => {
  await withActions(async (post, db, ids) => {
    assert.equal((await post(`triage/${ids.bug}/dismiss`, {})).status, 400);
    assert.equal((await post(`triage/${ids.bug}/accept`)).status, 200);
    assert.equal(getTicket(db, ids.bug)?.needs_triage, 0);
    assert.equal((await post(`triage/${ids.bug}/accept`)).status, 409, 'no longer needs triage');
    assert.equal((await post(`triage/${ids.bug}/dismiss`, { reason: 'known flake' })).status, 200);
    assert.equal(getTicket(db, ids.bug)?.status, 'wontfix');
    assert.equal(getTicket(db, ids.bug)?.resolution, 'known flake');
  });
});

test('POST pause / resume: the kill switch and live sessions, as the CLI does it', async () => {
  await withActions(async (post, db, _ids, lanternDir) => {
    const p = await post('pause');
    assert.equal(p.status, 200);
    assert.ok(existsSync(join(lanternDir, 'PAUSED')));
    assert.equal(getSession(db, 'sess-1')?.status, 'killed');
    assert.match(p.body.messages[0], /killed 1 session/);
    const r = await post('resume');
    assert.equal(r.status, 200);
    assert.ok(!existsSync(join(lanternDir, 'PAUSED')));
  });
});

test('POST sessions/:id/kill: kills a live session; a finished one is 409, unknown 404', async () => {
  await withActions(async (post, db) => {
    assert.equal((await post('sessions/sess-1/kill')).status, 200);
    assert.equal(getSession(db, 'sess-1')?.status, 'killed');
    assert.equal((await post('sessions/sess-1/kill')).status, 409);
    assert.equal((await post('sessions/nope/kill')).status, 404);
    assert.equal((await post('sessions/sess-1/restart')).status, 404);
  });
});

// ── transcripts ──────────────────────────────────────────────────────────

test('GET /api/transcripts: pulse and session summaries; 404 when none; paths from the DB only', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-tr-'));
  const ids = seed(lanternDir);
  const fixture = readFileSync(
    fileURLToPath(new URL('../../test/fixtures/transcript.jsonl', import.meta.url)),
  );
  mkdirSync(join(lanternDir, 'runs', String(ids.pulseId)), { recursive: true });
  writeFileSync(join(lanternDir, 'runs', String(ids.pulseId), 'orchestrator.jsonl'), fixture);
  const sessPath = join(lanternDir, 'runs', String(ids.pulseId), 'sess-1.jsonl');
  writeFileSync(sessPath, fixture);
  const db = openDb(join(lanternDir, 'lantern.db'));
  db.prepare('UPDATE sessions SET transcript_path = ? WHERE id = ?').run(sessPath, 'sess-1');
  db.close();

  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
      headers: { 'x-lantern-token': 't' },
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    const p = await get(`transcripts/pulse/${ids.pulseId}`);
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.denials, [{ tool: 'Bash', input: 'git push origin HEAD:main' }]);
    assert.equal(p.body.end.costUsd, 0.12);
    const s = await get('transcripts/session/sess-1');
    assert.equal(s.status, 200);
    assert.equal(s.body.init.mcpServers[0], 'lantern');

    assert.equal((await get('transcripts/pulse/999')).status, 404);
    assert.equal((await get('transcripts/session/nope')).status, 404);
    assert.equal((await get('transcripts/pulse/abc')).status, 400);
    assert.equal((await get('transcripts/other/1')).status, 404);
    // Traversal attempts resolve to nothing: the path is never taken from the URL.
    assert.equal((await get('transcripts/session/..%2F..%2Flantern.db')).status, 404);
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── run Lantern from the page ───────────────────────────────────────────────

test('POST agents: start/pulse launch through the launcher, stop, register; GET doctor; status shows running', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-ops-'));
  const ids = seed(lanternDir);
  const launched: string[][] = [];
  const ui = await startUiServer({
    lanternDir,
    port: 0,
    token: 't',
    launcher: (args) => {
      launched.push(args);
      return 777;
    },
  });
  const base = `http://127.0.0.1:${ui.port}/api/`;
  const post = async (p: string, body: object = {}) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: {
        'x-lantern-token': 't',
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${ui.port}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const get = async (p: string) => {
    const res = await fetch(base + p, { headers: { 'x-lantern-token': 't' } });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    const id = ids.agent.id;
    assert.equal((await get('status')).body.agents[0].running, false);

    const s = await post(`agents/${id}/start`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(launched, [['start', '--agent', id]]);
    assert.equal((await post('agents/nope/start')).status, 404);

    writeFileSync(join(lanternDir, `${id}.pid`), String(process.pid)); // "running"
    const st = (await get('status')).body.agents[0];
    assert.equal(st.running, true);
    assert.equal(st.pid, process.pid);
    assert.equal((await post(`agents/${id}/start`)).status, 409, 'already running');

    writeFileSync(join(lanternDir, `${id}.pid`), '999999'); // stale file: stop cleans it up
    const stop = await post(`agents/${id}/stop`);
    assert.equal(stop.status, 200);
    assert.ok(!existsSync(join(lanternDir, `${id}.pid`)));

    assert.equal((await post(`agents/${id}/pulse`)).status, 200);
    assert.deepEqual(launched.at(-1), ['pulse', '--now', '--agent', id]);

    const cfg = join(lanternDir, 'r.agent.md');
    writeFileSync(cfg, '---\nid: r\nworkdir: /tmp/r\n---\n## Mission\nm\n');
    assert.equal((await post('agents/register', { path: cfg })).status, 200);
    assert.equal((await get('status')).body.agents.length, 2);
    assert.equal((await post('agents/register', { path: 'rel.agent.md' })).status, 400);
    assert.equal((await post('agents/register', { path: 7 })).status, 400);

    const tripDb = openDb(join(lanternDir, 'lantern.db'));
    tripDb.prepare(`UPDATE agents SET state = 'tripped' WHERE id = 'r'`).run();
    tripDb.close();
    assert.equal((await post('agents/r/start')).status, 409, 'a tripped agent is refused');

    const doc = await get('doctor');
    assert.equal(doc.status, 200);
    assert.ok(doc.body.checks.some((c: { label: string }) => c.label === 'node version'));
    assert.equal(typeof doc.body.ok, 'boolean');
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('GET /api/sessions: carries the structured child result from the completed event', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-structured-'));
  const ids = seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, event, payload, session_id) VALUES (?, 'lantern', 'completed', ?, 'sess-1')`,
  ).run(
    ids.task,
    JSON.stringify({
      session_id: 'sess-1',
      structured: { outcome: 'partial', summary: 'Found it.' },
    }),
  );
  db.close();
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/sessions`, {
      headers: { 'x-lantern-token': 't' },
    });
    const rows = (await res.json()) as Json;
    assert.deepEqual(rows[0].structured, { outcome: 'partial', summary: 'Found it.' });
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── triage at scale ─────────────────────────────────────────────────────

test('GET /api/triage: each ticket carries the evidence that filed it', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-evidence-'));
  seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const emailBody = 'Steps to reproduce:\n1. Open settings\nTypeError: x is undefined';
  const mailId = createTicket(
    db,
    {
      kind: 'bug',
      title: 'Settings page crashes',
      // the shape inbox.bugs files: header lines, a rule, the message, prior art
      body: `**From:** a@b.c\n**Date:** 2025-01-01\n**Thread:** (none)\n\n---\n\n${emailBody}\n\n**Prior art:** #1 — some crash title`,
      origin: 'collector:email',
      needs_triage: true,
    },
    { actor: 't' },
  );
  db.prepare(
    `INSERT INTO observations (fingerprint, source, sample, occurrences, pulse_count) VALUES ('fp-x', 'logs', 's', 7, 3)`,
  ).run();
  const logId = createTicket(
    db,
    {
      kind: 'bug',
      title: '[logs] boom',
      body: 'b',
      origin: 'collector:logs',
      needs_triage: true,
      fingerprint: 'fp-x',
    },
    { actor: 't' },
  );
  db.close();
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/triage`, {
      headers: { 'x-lantern-token': 't' },
    });
    const rows = (await res.json()) as Json;
    const mail = rows.find((t: { id: number }) => t.id === mailId);
    const expected = bugEvidence({
      id: 'x',
      from: '',
      date: '',
      subject: 'Settings page crashes',
      body: emailBody,
    });
    assert.deepEqual(
      mail.evidence,
      { kind: 'email', ...expected },
      'the same evidence that decided, prior art excluded',
    );
    const log = rows.find((t: { id: number }) => t.id === logId);
    assert.deepEqual(log.evidence, { kind: 'logs', occurrences: 7, pulses: 3 });
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('POST /api/triage/bulk: one request accepts or dismisses many; failures are itemised', async () => {
  await withActions(async (post, db, ids) => {
    const more = [1, 2, 3].map((n) =>
      createTicket(
        db,
        { kind: 'bug', title: `b${n}`, body: 'b', origin: 'collector:logs', needs_triage: true },
        { actor: 't' },
      ),
    ) as [number, number, number];
    const acc = await post('triage/bulk', { action: 'accept', ids: [ids.bug, more[0]] });
    assert.equal(acc.status, 200);
    assert.deepEqual({ done: acc.body.done, failed: acc.body.failed }, { done: 2, failed: [] });
    assert.equal(getTicket(db, ids.bug)?.needs_triage, 0);

    assert.equal(
      (await post('triage/bulk', { action: 'dismiss', ids: [more[1]] })).status,
      400,
      'dismiss needs a reason',
    );
    const dis = await post('triage/bulk', {
      action: 'dismiss',
      reason: 'flaky monitor',
      ids: [more[1], more[2], 99999],
    });
    assert.equal(dis.status, 200);
    assert.equal(dis.body.done, 2);
    assert.deepEqual(dis.body.failed, [{ id: 99999, error: '#99999 not found' }]);
    assert.equal(getTicket(db, more[2])?.status, 'wontfix');
    assert.equal(getTicket(db, more[2])?.resolution, 'flaky monitor');

    assert.equal((await post('triage/bulk', { action: 'accept', ids: 'all' })).status, 400);
    assert.equal((await post('triage/bulk', { action: 'nuke', ids: [1] })).status, 400);
    assert.equal(
      (
        await post('triage/bulk', {
          action: 'accept',
          ids: Array.from({ length: 501 }, (_, i) => i + 1),
        })
      ).status,
      400,
      'capped batch size',
    );
  });
});

// ── agent health ─────────────────────────────────────────────────────────

test('GET /api/agents/:id: skips explained, spend series = usage_daily, findings, read-only config', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-health-'));
  initLantern(lanternDir);
  const cfg = join(lanternDir, 'h.agent.md');
  writeFileSync(
    cfg,
    `---\nid: h\nworkdir: /tmp/h\nheartbeat: 15m\nbudget:\n  per_day_usd: 4.00\n---\n## Mission\nKeep watch.\n`,
  );
  const db = openDb(join(lanternDir, 'lantern.db'));
  upsertAgentFromConfig(db, loadAgentConfig(cfg), cfg);
  db.prepare(`UPDATE agents SET next_pulse_at = ? WHERE id = 'h'`).run('2099-01-01T00:00:00.000Z');
  createSkippedPulse(db, {
    agentId: 'h',
    windowStart: '',
    windowEnd: '',
    reason: 'working tree is dirty',
  });
  const old = createSkippedPulse(db, {
    agentId: 'h',
    windowStart: '',
    windowEnd: '',
    reason: 'PAUSED file present',
  });
  db.prepare(`UPDATE pulses SET started_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 30 * 3600_000).toISOString(),
    old,
  );
  const p = createRunningPulse(db, { agentId: 'h', windowStart: '', windowEnd: '' });
  writePulseFinding(db, { pulseId: p, actionKey: 'logs.scan', outcome: 'clean' });
  writePulseFinding(db, { pulseId: p, actionKey: 'heartbeat.selfcheck', outcome: 'clean' });
  finishPulse(db, p, { status: 'clean', costUsd: 0.4 });
  const q = createRunningPulse(db, { agentId: 'h', windowStart: '', windowEnd: '' });
  writePulseFinding(db, { pulseId: q, actionKey: 'logs.scan', outcome: 'skipped' });
  finishPulse(db, q, { status: 'skipped', costUsd: 0.1 });
  db.close();

  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${path}`, {
      headers: { 'x-lantern-token': 't' },
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    const { status, body } = await get('agents/h');
    assert.equal(status, 200);
    assert.equal(body.agent.id, 'h');
    assert.equal(body.agent.next_pulse_at, '2099-01-01T00:00:00.000Z');
    // only the last 24 h, newest first, explained
    assert.equal(body.skips.length, 1);
    assert.equal(body.skips[0].reason, 'working tree is dirty');
    assert.match(body.skips[0].plain, /uncommitted/);
    assert.match(body.skips[0].fix, /allow_dirty/);
    // spend: the hourly series adds up to exactly what usage_daily recorded
    const usage = (await get('status')).body.spend.cost_usd;
    const total = body.spend.series.reduce((a: number, b: number) => a + b, 0);
    assert.ok(
      Math.abs(total - usage) < 1e-9 && Math.abs(usage - 0.5) < 1e-9,
      `${total} vs ${usage}`,
    );
    assert.equal(body.spend.ceilingUsd, 4);
    // findings per action over 24 h
    assert.deepEqual(body.findings24h, [
      { action_key: 'heartbeat.selfcheck', clean: 1, finding: 0, skipped: 0, error: 0 },
      { action_key: 'logs.scan', clean: 1, finding: 0, skipped: 1, error: 0 },
    ]);
    // the effective config
    assert.equal(body.config.heartbeatSeconds, 900);
    assert.equal(body.config.budget.perDayUsd, 4);
    assert.equal(body.config.mission, 'Keep watch.');
    assert.equal(body.config.configPath, cfg);
    assert.equal((await get('agents/nope')).status, 404);
    // the status list carries each agent's latest skip for its card
    const card = (await get('status')).body.agents.find((a: { id: string }) => a.id === 'h');
    assert.equal(card.lastSkip, null, 'the latest pulse ran, so no current skip');
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('POST agents/:id/config: operational settings only; increases need confirm; file-only refused', async () => {
  await withActions(async (post, db, _ids, lanternDir) => {
    const path = join(lanternDir, 'edit.agent.md');
    writeFileSync(
      path,
      `---\nid: edit\nworkdir: ${lanternDir}\nbudget:\n  per_pulse_usd: 1.00\n  per_day_usd: 5.00\n---\n## Mission\nm\n`,
    );
    upsertAgentFromConfig(db, loadAgentConfig(path), path);

    const down = await post('agents/edit/config', { per_day_usd: 4 });
    assert.equal(down.status, 200, JSON.stringify(down.body));
    assert.equal(loadAgentConfig(path).budget.perDayUsd, 4);

    const up = await post('agents/edit/config', { per_day_usd: 9 });
    assert.equal(up.status, 409);
    assert.equal(up.body.needsConfirm, true);
    assert.equal(loadAgentConfig(path).budget.perDayUsd, 4, 'unchanged until confirmed');
    assert.equal((await post('agents/edit/config', { per_day_usd: 9, confirm: true })).status, 200);

    // What a child may run or touch never changes from the page (Law 6's spirit).
    for (const body of [
      { test_commands: ['sh x'] },
      { workdir: '/' },
      { per_day_usd: 999, confirm: true },
    ]) {
      assert.equal((await post('agents/edit/config', body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(loadAgentConfig(path).testCommands, []);
    assert.equal((await post('agents/nope/config', { per_day_usd: 1 })).status, 404);
  });
});

// ── live child sessions ─────────────────────────────────────────────────

test('GET /api/transcripts/session/:id?from=: only what is new, plus the session, its result and follow-ups', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-live-'));
  const ids = seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const path = join(lanternDir, 'runs', String(ids.pulseId), 'sess-1.jsonl');
  mkdirSync(join(lanternDir, 'runs', String(ids.pulseId)), { recursive: true });
  const lines = readFileSync(
    fileURLToPath(new URL('../../test/fixtures/transcript.jsonl', import.meta.url)),
    'utf8',
  )
    .split('\n')
    .filter((l) => l.trim().startsWith('{'));
  writeFileSync(path, `${lines[0]}\n`);
  db.prepare("UPDATE sessions SET transcript_path = ?, status = 'running' WHERE id = 'sess-1'").run(
    path,
  );
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
      headers: { 'x-lantern-token': 't' },
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    const first = await get('transcripts/session/sess-1');
    assert.equal(first.status, 200);
    assert.equal(first.body.session.status, 'running');
    assert.equal(first.body.session.structured, null);
    assert.equal(first.body.steps.length, 0);

    writeFileSync(path, `${lines.join('\n')}\n`);
    const next = await get(`transcripts/session/sess-1?from=${first.body.nextOffset}`);
    assert.equal(next.body.init, null, 'only the new lines');
    assert.ok(next.body.steps.length > 0);
    assert.ok(next.body.end);
    assert.equal((await get('transcripts/session/sess-1?from=-5')).status, 400);

    // The child finishes: its App. C result and the follow-up it filed, linked.
    const follow = createTicket(
      db,
      { kind: 'bug', title: 'Also check the retry path', body: 'b', origin: 'agent:child' },
      { actor: 'lantern', session_id: 'sess-1' },
    );
    db.prepare(
      `INSERT INTO ticket_events (ticket_id, actor, event, payload, session_id) VALUES (?, 'lantern', 'completed', ?, 'sess-1')`,
    ).run(
      ids.task,
      JSON.stringify({
        structured: {
          outcome: 'fixed',
          summary: 'Off by one.',
          root_cause: 'loop bound',
          files_touched: ['sum.js'],
        },
      }),
    );
    db.prepare("UPDATE sessions SET status = 'done' WHERE id = 'sess-1'").run();
    const done = await get(`transcripts/session/sess-1?from=${next.body.nextOffset}`);
    assert.equal(done.body.session.structured.outcome, 'fixed');
    assert.deepEqual(
      done.body.session.followUps.map((f: Json) => [f.id, f.title]),
      [[follow, 'Also check the retry path']],
    );

    // …and the same result on its ticket.
    const t = await get(`tickets/${ids.task}`);
    assert.equal(t.body.sessions.length, 1);
    assert.equal(t.body.sessions[0].structured.root_cause, 'loop bound');
    assert.equal(t.body.sessions[0].followUps[0].id, follow);
  } finally {
    await ui.close();
    db.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── ticket workspace ────────────────────────────────────────────────────

test('POST tickets/:id: comment, priority, close (resolution required), reopen — each writes its event', async () => {
  await withActions(async (post, db, ids) => {
    const events = () => getTicketEvents(db, ids.task).map((e) => e.event);
    const before = events().length;

    assert.equal((await post(`tickets/${ids.task}/comment`, { body: '  ' })).status, 400);
    const c = await post(`tickets/${ids.task}/comment`, { body: 'Checked prod: only staging.' });
    assert.equal(c.status, 200);
    const last = getTicketEvents(db, ids.task).at(-1);
    assert.equal(last?.event, 'commented');
    assert.equal(last?.actor, 'human');
    assert.deepEqual(JSON.parse(last?.payload ?? '{}'), { body: 'Checked prod: only staging.' });

    assert.equal((await post(`tickets/${ids.task}/priority`, { priority: 'p9' })).status, 400);
    assert.equal((await post(`tickets/${ids.task}/priority`, { priority: 'p0' })).status, 200);
    assert.equal(getTicket(db, ids.task)?.priority, 'p0');
    assert.equal(
      (await post(`tickets/${ids.task}/priority`, { priority: 'p0' })).status,
      409,
      'already p0',
    );

    // Close without a resolution is refused here exactly as in the tool layer.
    const refused = await post(`tickets/${ids.task}/close`, { status: 'closed', resolution: ' ' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /resolution/);
    assert.equal(getTicket(db, ids.task)?.status, 'open');
    assert.equal(
      (await post(`tickets/${ids.task}/close`, { status: 'open', resolution: 'x' })).status,
      400,
      'close takes closed / wontfix / duplicate only',
    );
    assert.equal(
      (await post(`tickets/${ids.task}/close`, { status: 'closed', resolution: 'Rotated.' }))
        .status,
      200,
    );
    assert.equal(getTicket(db, ids.task)?.status, 'closed');
    assert.equal(getTicket(db, ids.task)?.resolution, 'Rotated.');
    assert.equal(
      (await post(`tickets/${ids.task}/close`, { status: 'closed', resolution: 'again' })).status,
      409,
      'already closed',
    );

    assert.equal((await post(`tickets/${ids.task}/reopen`, { reason: '' })).status, 400);
    assert.equal((await post(`tickets/${ids.task}/reopen`, { reason: 'Came back.' })).status, 200);
    const t = getTicket(db, ids.task);
    assert.equal(t?.status, 'open');
    assert.equal(t?.closed_at, null);
    assert.equal(t?.resolution, null, 'the old resolution lives in the closed event');
    assert.equal((await post(`tickets/${ids.task}/reopen`, { reason: 'x' })).status, 409);

    assert.deepEqual(events().slice(before), ['commented', 'updated', 'closed', 'reopened']);
    assert.equal((await post('tickets/999/comment', { body: 'x' })).status, 404);
    assert.equal((await post(`tickets/${ids.task}/delete`)).status, 404);
  });
});

test('GET /api/tickets/:id: a prior-art panel of similar tickets, never itself', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-prior-'));
  const ids = seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const similar = createTicket(
    db,
    { kind: 'chore', title: 'Rotate keys for staging', body: 'rotate keys', origin: 'human' },
    { actor: 'test' },
  );
  db.close();
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  try {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/tickets/${ids.task}`, {
      headers: { 'x-lantern-token': 't' },
    });
    const body = (await res.json()) as Json;
    const found = body.priorArt.map((p: Json) => p.id);
    assert.ok(found.includes(similar), JSON.stringify(body.priorArt));
    assert.ok(!found.includes(ids.task), 'never itself');
    assert.equal(typeof body.priorArt[0].title, 'string');
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── pagination ──────────────────────────────────────────────────────────

test('GET /api/tickets?page= and /api/sessions?page=: 50 a page, with whether there is more', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-pages-'));
  const ids = seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  for (let i = 0; i < 118; i++) {
    createTicket(
      db,
      { kind: 'chore', title: `bulk ${i}`, body: 'b', origin: 'human' },
      { actor: 't' },
    );
  }
  for (let i = 0; i < 60; i++) {
    createSession(db, { id: `bulk-${i}`, agentId: ids.agent.id, tier: 'read_only' });
  }
  db.close();
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  const get = async (p: string) =>
    (await (
      await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, { headers: { 'x-lantern-token': 't' } })
    ).json()) as Json;
  try {
    // 2 seeded + 118 = 120 tickets: 50 + 50 + 20.
    const p1 = await get('tickets?page=1');
    assert.equal(p1.rows.length, 50);
    assert.equal(p1.more, true);
    const p3 = await get('tickets?page=3');
    assert.equal(p3.rows.length, 20);
    assert.equal(p3.more, false);
    const seen = new Set(
      [...p1.rows, ...(await get('tickets?page=2')).rows, ...p3.rows].map((t: Json) => t.id),
    );
    assert.equal(seen.size, 120, 'pages do not overlap or skip');
    assert.ok(Array.isArray(await get('tickets')), 'without page: the plain array, as before');
    assert.equal((await get('tickets?page=0')).error, 'page must be a positive integer');

    const s2 = await get('sessions?page=2');
    assert.equal(s2.rows.length, 11, '61 sessions: 50 + 11');
    assert.equal(s2.more, false);
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── metrics ────────────────────────────────────────────────────────────

test('GET /api/metrics: the six metrics over ?days=, validated', async () => {
  await withApi(async (get) => {
    const r = await get('metrics');
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 30);
    for (const k of [
      'pulses',
      'findings',
      'precision',
      'observationToTicketHours',
      'ticketToCloseHours',
      'humanTouches',
      'cost',
    ]) {
      assert.ok(k in r.body, k);
    }
    assert.equal(r.body.pulses.run, 1, 'the seeded pulse');
    assert.equal((await get('metrics?days=7')).body.days, 7);
    assert.equal((await get('metrics?days=0')).status, 400);
    assert.equal(
      (await get('overview?view=metrics')).body.view.days,
      30,
      'one request with the chrome',
    );
  });
});

// ── The Claude section ───────────────────────────

test('GET /api/claude and POST claude/test: status without secrets; one injected test turn, 202 then 409', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-claude-'));
  seed(lanternDir);
  let calls = 0;
  const ui = await startUiServer({
    lanternDir,
    port: 0,
    token: 't',
    claudeRunner: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        code: 0,
        stdout: JSON.stringify({
          is_error: false,
          result: 'OK',
          total_cost_usd: 0.012,
          modelUsage: { 'claude-opus-5-5': {} },
        }),
        stderr: '',
      };
    },
  });
  const base = `http://127.0.0.1:${ui.port}/api/`;
  const get = async (p: string) =>
    (await (await fetch(base + p, { headers: { 'x-lantern-token': 't' } })).json()) as Json;
  const post = (p: string) =>
    fetch(base + p, {
      method: 'POST',
      headers: {
        'x-lantern-token': 't',
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${ui.port}`,
      },
      body: '{}',
    });
  try {
    const s = await get('claude');
    assert.ok(['api_key', 'subscription', 'none'].includes(s.auth.mode));
    assert.equal(typeof s.howTo.subscription, 'string');
    assert.doesNotMatch(JSON.stringify(s), /sk-ant/, 'never a key');
    assert.equal((await post('claude/test')).status, 202);
    assert.equal((await post('claude/test')).status, 409, 'one at a time');
    await new Promise((r) => setTimeout(r, 120));
    const after = await get('claude');
    assert.equal(after.test.ok, true);
    assert.equal(after.test.reply, 'OK');
    assert.equal(calls, 1);
    assert.equal((await post('claude/other')).status, 404);
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

// ── ci.watch evidence on triage cards ──────────────────────────────────

test('GET /api/triage: a ci ticket carries its commit, pass/fail counts and the failure line', async () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-ci-evidence-'));
  const ids = seed(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const res = (outcome: 'pass' | 'fail') => ({
    testId: 'Demo#halfTheTime',
    classname: 'Demo',
    name: 'halfTheTime',
    outcome,
    ms: 1,
    message: outcome === 'fail' ? 'expected: <true> but was: <false>\n\tat Demo.java:23' : '',
    flaky: false,
  });
  for (const o of ['fail', 'pass', 'pass'] as const) {
    const runId = recordRun(db, {
      agentId: ids.agent.id,
      pulseId: null,
      sha: 'abcdef1234567',
      exitCode: o === 'fail' ? 1 : 0,
      results: [res(o)],
    });
    ticketCiRun(db, ids.agent, null, runId);
  }
  db.close();
  const ui = await startUiServer({ lanternDir, port: 0, token: 't' });
  try {
    const rows = (await (
      await fetch(`http://127.0.0.1:${ui.port}/api/triage`, { headers: { 'x-lantern-token': 't' } })
    ).json()) as Json[];
    const ci = rows.find((t: Json) => t.origin === 'collector:ci');
    assert.deepEqual(ci?.evidence, {
      kind: 'ci',
      ciKind: 'flaky',
      testId: 'Demo#halfTheTime',
      commit: 'abcdef12',
      runs: 3,
      pass: 2,
      fail: 1,
      lastFailure: 'expected: <true> but was: <false>',
    });
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
});
