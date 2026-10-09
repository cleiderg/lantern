import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initLantern } from '../init.ts';
import { startUiServer, type UiServer } from './server.ts';

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Raw node:http, so tests can send a forged Host or Origin (fetch won't). */
function send(
  ui: UiServer,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ui.port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function withUi(fn: (ui: UiServer) => Promise<void>) {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-'));
  initLantern(lanternDir);
  const ui = await startUiServer({ lanternDir, port: 0, token: 'tok-123' });
  try {
    await fn(ui);
  } finally {
    await ui.close();
    rmSync(lanternDir, { recursive: true, force: true });
  }
}

test('lantern ui: binds to 127.0.0.1 only and prints a tokened URL', async () => {
  await withUi(async (ui) => {
    assert.equal(ui.address, '127.0.0.1');
    assert.equal(ui.url, `http://127.0.0.1:${ui.port}/?t=tok-123`);
  });
});

test('lantern ui: the page needs the token', async () => {
  await withUi(async (ui) => {
    assert.equal((await send(ui, '/')).status, 403);
    assert.equal((await send(ui, '/?t=wrong')).status, 403);
    const ok = await send(ui, '/?t=tok-123');
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<title>Lantern<\/title>/);
    assert.match(String(ok.headers['content-security-policy']), /script-src 'self'/);
    assert.doesNotMatch(String(ok.headers['content-security-policy']), /unsafe-inline/);
    assert.equal(ok.headers['referrer-policy'], 'no-referrer');
    assert.equal(ok.headers['cache-control'], 'no-store');
  });
});

test('lantern ui: the API needs the token', async () => {
  await withUi(async (ui) => {
    assert.equal((await send(ui, '/api/status')).status, 403);
    assert.notEqual(
      (await send(ui, '/api/status', { headers: { 'x-lantern-token': 'tok-123' } })).status,
      403,
    );
  });
});

test('lantern ui: a forged Host is refused even with the token (DNS rebinding)', async () => {
  await withUi(async (ui) => {
    const r = await send(ui, '/?t=tok-123', { headers: { host: `evil.example:${ui.port}` } });
    assert.equal(r.status, 403);
    assert.match(r.body, /host/i);
    const local = await send(ui, '/?t=tok-123', { headers: { host: `localhost:${ui.port}` } });
    assert.equal(local.status, 200);
  });
});

test('lantern ui: a state-changing request needs JSON, the token header and a matching Origin', async () => {
  await withUi(async (ui) => {
    const origin = `http://127.0.0.1:${ui.port}`;
    const good = { 'content-type': 'application/json', 'x-lantern-token': 'tok-123', origin };
    const post = (headers: Record<string, string>) =>
      send(ui, '/api/nope', { method: 'POST', headers, body: '{}' });

    // Checks run before routing: a refusal is 403/415; passing them reaches a 404.
    assert.equal((await post(good)).status, 404);
    assert.equal((await post({ ...good, origin: 'http://evil.example' })).status, 403);
    const { origin: _o, ...noOrigin } = good;
    assert.equal((await post(noOrigin)).status, 403);
    assert.equal((await post({ ...good, 'content-type': 'text/plain' })).status, 415);
    // A token in the query string is not enough for a POST: forms can set a URL, not a header.
    const { 'x-lantern-token': _t, ...noHeader } = good;
    const viaQuery = await send(ui, '/api/nope?t=tok-123', {
      method: 'POST',
      headers: noHeader,
      body: '{}',
    });
    assert.equal(viaQuery.status, 403);
  });
});

test('lantern ui: static assets are served with the same headers and no token', async () => {
  await withUi(async (ui) => {
    const js = await send(ui, '/app.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /javascript/);
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal((await send(ui, '/app.css')).status, 200);
    assert.equal((await send(ui, '/../lantern.db')).status, 404);
  });
});

test('lantern ui: /favicon.svg carries a count badge — a clamped number, never other input', async () => {
  await withUi(async (ui) => {
    const plain = await send(ui, '/favicon.svg');
    assert.equal(plain.status, 200, 'no token needed: it holds no data');
    assert.match(String(plain.headers['content-type']), /image\/svg\+xml/);
    assert.doesNotMatch(plain.body, /class="badge"/);
    const three = await send(ui, '/favicon.svg?n=3');
    assert.match(three.body, /class="badge"/);
    assert.match(three.body, />3</);
    assert.match((await send(ui, '/favicon.svg?n=250')).body, />99\+</);
    for (const bad of ['-1', 'abc', '<script>', '1e9x']) {
      const r = await send(ui, `/favicon.svg?n=${encodeURIComponent(bad)}`);
      assert.doesNotMatch(r.body, /class="badge"|script/, bad);
    }
    assert.match(String(plain.headers['content-security-policy']), /img-src 'self'/);
  });
});

test('lantern ui: a port already in use is a clear refusal, not a crash', async () => {
  await withUi(async (first) => {
    const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-ui-busy-'));
    initLantern(lanternDir);
    try {
      await assert.rejects(
        startUiServer({ lanternDir, port: first.port, token: 'x' }),
        new RegExp(`port ${first.port} is already in use.*--port`),
      );
    } finally {
      rmSync(lanternDir, { recursive: true, force: true });
    }
  });
});
