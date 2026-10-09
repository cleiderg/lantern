/**
 * Live updates: a stable per-LANTERN_DIR token, the SSE change stream,
 * and the one-call overview.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { createEscalation } from '../store/escalations.ts';
import { createRunningPulse } from '../store/pulses.ts';
import { createSession } from '../store/sessions.ts';
import { startUiServer } from './server.ts';

// Loose on purpose: each test asserts the fields it reads.
// biome-ignore lint/suspicious/noExplicitAny: JSON bodies checked field by field
type Json = any;

function lantern() {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-events-'));
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

test('lantern ui: the token is stable per LANTERN_DIR, stored 0600 — a restart keeps open pages working', async () => {
  const l = lantern();
  try {
    const a = await startUiServer({ lanternDir: l.lanternDir, port: 0 });
    await a.close();
    const b = await startUiServer({ lanternDir: l.lanternDir, port: 0 });
    await b.close();
    assert.equal(a.token, b.token);
    assert.match(a.token, /^[0-9a-f]{32}$/);
    assert.equal(statSync(join(l.lanternDir, 'ui.token')).mode & 0o777, 0o600);
  } finally {
    l.cleanup();
  }
});

/** Read SSE events from /api/events until `until` returns true or the timeout passes. */
function readEvents(
  port: number,
  path: string,
  until: (events: Array<{ event: string; data: string }>) => boolean,
  ms = 4000,
) {
  return new Promise<{
    status: number;
    type: string;
    events: Array<{ event: string; data: string }>;
  }>((resolve) => {
    const events: Array<{ event: string; data: string }> = [];
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let buf = '';
      const done = () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), events });
      };
      const timer = setTimeout(done, ms);
      res.on('data', (c) => {
        buf += c;
        let i = buf.indexOf('\n\n');
        while (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
          if (!block.startsWith(':')) events.push({ event: ev, data });
          if (until(events)) {
            clearTimeout(timer);
            done();
            return;
          }
          i = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), events });
      });
    });
    req.on('error', () => resolve({ status: 0, type: '', events }));
    req.end();
  });
}

test('GET /api/events: SSE stream says hello, then names what changed — and only that', async () => {
  const l = lantern();
  const ui = await startUiServer({ lanternDir: l.lanternDir, port: 0, token: 't' });
  try {
    assert.equal(
      (await readEvents(ui.port, '/api/events', () => true, 500)).status,
      403,
      'token required',
    );

    const pending = readEvents(ui.port, '/api/events?t=t', (evs) =>
      evs.some((e) => e.event === 'change'),
    );
    await new Promise((r) => setTimeout(r, 300)); // let it say hello and take a baseline
    createRunningPulse(l.db, { agentId: l.agent.id, windowStart: '', windowEnd: '' });
    createEscalation(l.db, { agentId: l.agent.id, severity: 'fyi', question: 'q' });
    const r = await pending;
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/event-stream/);
    assert.equal(r.events[0]?.event, 'hello');
    const change = r.events.find((e) => e.event === 'change');
    assert.ok(change, 'a change event within the window');
    const domains = (JSON.parse(change.data) as { domains: string[] }).domains;
    assert.ok(
      domains.includes('pulses') && domains.includes('escalations'),
      JSON.stringify(domains),
    );
    assert.ok(!domains.includes('tickets'), 'unchanged areas are not named');
    assert.doesNotMatch(change.data, /"q"/, 'events carry names of areas, never content');
  } finally {
    await ui.close();
    l.cleanup();
  }
});

test('GET /api/overview: status and the current view in one call', async () => {
  const l = lantern();
  createEscalation(l.db, { agentId: l.agent.id, severity: 'decide', question: 'Ship?' });
  const ui = await startUiServer({ lanternDir: l.lanternDir, port: 0, token: 't' });
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/${p}`, {
      headers: { 'x-lantern-token': 't' },
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  try {
    const o = await get('overview?view=inbox');
    assert.equal(o.status, 200);
    assert.equal(o.body.status.unanswered, 1);
    assert.equal(o.body.view[0].question, 'Ship?');
    const t = await get('overview?view=tickets&status=open');
    assert.deepEqual(t.body.view, []);
    assert.equal(
      (await get('overview?view=pulses&p=999')).status,
      404,
      'a sub-resource 404 passes through',
    );
    assert.equal((await get('overview?view=nope')).status, 404);
    assert.equal((await get('overview')).body.view, null, 'no view: status only');
  } finally {
    await ui.close();
    l.cleanup();
  }
});

test('GET /api/events: a live child writing its transcript is a change — within 1 s', async () => {
  const l = lantern();
  const path = join(l.lanternDir, 'child.jsonl');
  writeFileSync(path, '{"type":"system","subtype":"init"}\n');
  createSession(l.db, { id: 'live-1', agentId: l.agent.id, tier: 'read_only' });
  l.db
    .prepare("UPDATE sessions SET status = 'running', transcript_path = ? WHERE id = 'live-1'")
    .run(path);
  const ui = await startUiServer({ lanternDir: l.lanternDir, port: 0, token: 't' });
  try {
    const pending = readEvents(ui.port, '/api/events?t=t', (evs) =>
      evs.some((e) => e.event === 'change'),
    );
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    appendFileSync(path, '{"type":"assistant","message":{"content":[]}}\n');
    const r = await pending;
    const change = r.events.find((e) => e.event === 'change');
    assert.ok(change, 'a change event');
    assert.deepEqual(JSON.parse(change.data).domains, ['transcripts']);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    assert.doesNotMatch(change.data, /assistant/, 'names the area, never the content');
  } finally {
    await ui.close();
    l.cleanup();
  }
});
