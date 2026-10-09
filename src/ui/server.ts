/**
 * `lantern ui` — one local page over Lantern's DB, and nothing more.
 *
 * Security model, checked on every request before
 * any routing:
 *   - bound to 127.0.0.1; `Host` must name that address and port, which
 *     defeats DNS rebinding (a hostile site resolving its own name to us);
 *   - the page and the API need the per-run token (`?t=` or `X-Lantern-Token`);
 *   - a POST needs `Content-Type: application/json`, the token *header* (a
 *     cross-site form can set a URL, never a header) and an `Origin` of this
 *     server, so no other site can approve a release through this page.
 * Every response carries a CSP that allows only this origin's own script and
 * style — defence in depth behind rendering collected text with textContent.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Launcher, launchDetached } from '../actions.ts';
import { type ClaudeRunner, runClaude } from '../claude-status.ts';
import { openDb } from '../db.ts';
import { GET_ROUTES, POST_ROUTES, type Route } from './api.ts';
import { changedDomains, snapshot } from './changes.ts';

export type UiServer = {
  address: string;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
};

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'page.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const MAX_BODY = 64 * 1024;

/**
 * The tab icon, with a count badge when something needs a person. Built
 * from a clamped integer only — no other input reaches the SVG — and holds no
 * data, so like the page's script it needs no token.
 */
export function faviconSvg(raw: string | null): string {
  const n = raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  const label = n > 99 ? '99+' : String(n);
  const badge =
    n > 0
      ? `<g class="badge"><circle cx="46" cy="18" r="18" fill="#e5484d"/>` +
        `<text x="46" y="25" font-family="system-ui,sans-serif" font-size="${label.length > 2 ? 15 : 21}" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></g>`
      : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<circle cx="30" cy="34" r="20" fill="none" stroke="#6e6af0" stroke-width="8" stroke-dasharray="100 26" stroke-linecap="round"/>` +
    `${badge}</svg>`
  );
}
/** How often the event stream looks for changes; the page sees them within this. */
const CHANGE_POLL_MS = 400;

const HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function sameToken(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The token is stable per LANTERN_DIR: stored in <lanternDir>/ui.token, mode
 * 0600, so a restarted `lantern ui` accepts the pages already open on it and their
 * event streams reconnect on their own. Delete the file to rotate it.
 */
function loadOrCreateToken(lanternDir: string): string {
  const path = join(lanternDir, 'ui.token');
  if (existsSync(path)) {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) {
      chmodSync(path, 0o600);
      return t;
    }
  }
  const t = randomBytes(16).toString('hex');
  writeFileSync(path, `${t}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

export async function startUiServer(opts: {
  lanternDir: string;
  port?: number;
  token?: string;
  /** Starts detached `lantern` processes; tests pass a fake so nothing real runs. */
  launcher?: Launcher;
  /** Runs the Claude test turn (the real CLI by default); injectable for tests. */
  claudeRunner?: ClaudeRunner;
}): Promise<UiServer> {
  const launcher = opts.launcher ?? launchDetached;
  const claudeRunner = opts.claudeRunner ?? runClaude;
  const token = opts.token ?? loadOrCreateToken(opts.lanternDir);
  const db = openDb(join(opts.lanternDir, 'lantern.db'));
  let port = 0;

  const reply = (res: ServerResponse, status: number, body: string, type: string) => {
    res.writeHead(status, { ...HEADERS, 'content-type': type });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    reply(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      return json(res, 403, { error: 'bad host' });
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      return reply(res, 200, faviconSvg(url.searchParams.get('n')), 'image/svg+xml');
    }
    // the page's ES modules, by plain name only — nothing else under js/.
    const mod = /^\/js\/([a-z][a-z0-9-]*)\.js$/.exec(url.pathname);
    if (req.method === 'GET' && mod && existsSync(join(HERE, 'js', `${mod[1]}.js`))) {
      return reply(
        res,
        200,
        readFileSync(join(HERE, 'js', `${mod[1]}.js`), 'utf8'),
        'text/javascript; charset=utf-8',
      );
    }
    const asset = req.method === 'GET' ? ASSETS[url.pathname] : undefined;
    if (asset) {
      // The page itself is the token's front door; its script and style are not secret.
      if (url.pathname === '/' && !sameToken(url.searchParams.get('t'), token)) {
        return reply(res, 403, 'lantern ui: open the URL printed by `lantern ui`\n', 'text/plain');
      }
      return reply(res, 200, readFileSync(join(HERE, asset.file), 'utf8'), asset.type);
    }

    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const header = req.headers['x-lantern-token'];
    const headerToken = Array.isArray(header) ? header[0] : header;
    let body: Record<string, unknown> = {};

    if (req.method === 'POST') {
      if (!sameToken(headerToken, token)) return json(res, 403, { error: 'bad token' });
      const origins = allowedHosts.map((h) => `http://${h}`);
      if (!origins.includes(req.headers.origin ?? '')) {
        return json(res, 403, { error: 'bad origin' });
      }
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return json(res, 415, { error: 'expected application/json' });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return json(res, 413, { error: 'body too large' });
      }
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'body must be a JSON object' });
      }
    } else if (req.method === 'GET') {
      if (!sameToken(headerToken ?? url.searchParams.get('t'), token)) {
        return json(res, 403, { error: 'bad token' });
      }
    } else {
      return json(res, 405, { error: 'method not allowed' });
    }

    // The live change stream. Names what changed, never content.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return streamChanges(req, res);
    }

    const [name = '', ...params] = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
    const table: Record<string, Route> = req.method === 'POST' ? POST_ROUTES : GET_ROUTES;
    const route = Object.hasOwn(table, name) ? table[name] : undefined;
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      const r = route({
        db,
        lanternDir: opts.lanternDir,
        params,
        query: url.searchParams,
        body,
        launcher,
        claudeRunner,
      });
      return json(res, r.status, r.json);
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const streamChanges = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      ...HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    });
    // retry: how soon the browser reconnects if `lantern ui` goes away.
    res.write('retry: 2000\nevent: hello\ndata: {}\n\n');
    let last = snapshot(db, opts.lanternDir);
    const tick = setInterval(() => {
      try {
        const now = snapshot(db, opts.lanternDir);
        const domains = changedDomains(last, now);
        last = now;
        if (domains.length) res.write(`event: change\ndata: ${JSON.stringify({ domains })}\n\n`);
      } catch {
        // a transient DB error (busy, closing): try again next tick
      }
    }, CHANGE_POLL_MS);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(tick);
      clearInterval(ping);
    });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => json(res, 500, { error: String(e) }));
  });
  await new Promise<void>((resolve, reject) => {
    // Without an 'error' listener a busy port never settles this promise, and
    // the unhandled error surfaces as a raw EADDRINUSE crash.
    server.once('error', (e: NodeJS.ErrnoException) => {
      db.close();
      reject(
        e.code === 'EADDRINUSE'
          ? new Error(
              `port ${opts.port} is already in use — is another \`lantern ui\` running? ` +
                'Stop it, or pick another port with --port <n>',
            )
          : e,
      );
    });
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;

  return {
    address: addr.address,
    port,
    token,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}
