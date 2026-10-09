/**
 * The ui:smoke harness: headless Chrome over the DevTools protocol
 * (Node's built-in WebSocket — no dependency), and `lantern ui` started through
 * the real CLI on a throwaway LANTERN_DIR.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LANTERN_BIN = fileURLToPath(new URL('../../bin/lantern', import.meta.url));
const CDP_PORT = 9339;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `lantern ui` on `port` for `lanternDir`, with only `fakeBin` on PATH; `ready` is its URL. */
export function startUi(lanternDir: string, fakeBin: string, port: number) {
  const proc = spawn(process.execPath, [LANTERN_BIN, 'ui', '--port', String(port)], {
    // Only the fake `claude` on PATH: a daemon started from the page can never run a real turn.
    env: { ...process.env, LANTERN_DIR: lanternDir, PATH: fakeBin, LANTERN_DISABLE_NOTIFY: '1' },
  });
  const ready = new Promise<string>((resolve, reject) => {
    let out = '';
    proc.stdout?.on('data', (c) => {
      out += c;
      const m = /ui at (http:\/\/\S+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    proc.on('exit', (code) => reject(new Error(`lantern ui exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`lantern ui printed no URL: ${out}`)), 10_000);
  });
  return { proc, ready };
}

/** One headless Chrome page, driven through CDP. */
export class Browser {
  private seq = 0;
  private readonly pending = new Map<number, (v: unknown) => void>();

  readonly chrome: ChildProcess;
  private readonly ws: WebSocket;

  // No parameter properties: Node's strip-only TypeScript rejects them.
  private constructor(chrome: ChildProcess, ws: WebSocket) {
    this.chrome = chrome;
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
      if (msg.id && this.pending.has(msg.id)) this.pending.get(msg.id)?.(msg.result);
    };
  }

  static async launch(profileDir: string): Promise<Browser> {
    const chrome = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(profileDir, 'chrome')}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ]);
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await sleep(200);
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch {
        // not up yet
      }
    }
    if (!wsUrl) {
      chrome.kill('SIGKILL');
      throw new Error('Chrome DevTools endpoint did not come up');
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const b = new Browser(chrome, ws);
    await b.cdp('Page.enable');
    await b.cdp('Runtime.enable');
    // A human would click OK on the confirm() for Approve; the smoke does too.
    await b.cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.confirm = () => true;',
    });
    return b;
  }

  cdp = (method: string, params: object = {}) =>
    new Promise<unknown>((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });

  evaluate = async (expression: string) => {
    const r = (await this.cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value: unknown } };
    return r.result.value;
  };

  text = () => this.evaluate("document.getElementById('view').innerText") as Promise<string>;
  hash = () => this.evaluate('location.hash') as Promise<string>;
  visible = (id: string) =>
    this.evaluate(`!document.getElementById('${id}').hidden`) as Promise<boolean>;

  /** Milliseconds until `pred` holds, or -1 after `ms`. */
  waitFor = async (pred: () => Promise<boolean>, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return Date.now() - t0;
      await sleep(50);
    }
    return -1;
  };

  /** A real key event through Chrome's input pipeline. */
  press = async (key: string, code: number, modifiers = 0) => {
    const base = {
      key,
      code: key === 'Enter' ? 'Enter' : key,
      windowsVirtualKeyCode: code,
      modifiers,
    };
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      ...base,
      ...(key === 'Enter' ? { text: '\r' } : {}),
    });
    if (key === 'Enter')
      await this.cdp('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  async open(url: string): Promise<void> {
    await this.cdp('Emulation.setEmulatedMedia', { features: [] });
    await this.cdp('Page.navigate', { url });
    await sleep(1500);
  }

  close(): void {
    this.ws.close();
    this.chrome.kill('SIGKILL');
  }
}
