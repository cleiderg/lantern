/**
 * The UI's "Claude" section: what Lantern's Claude
 * connection is, and a one-turn test of it. Read-only apart from the test —
 * auth is changed in a terminal (`claude login` or ANTHROPIC_API_KEY), never
 * from the page, and the key itself is never returned.
 *
 * The test is a real, sandboxed turn: no tools, Lantern's MCP config only, one
 * turn, a $0.05 ceiling. It is refused while the kill switch is on, runs one
 * at a time, and its cost goes into usage_daily like any other turn (Law 7).
 */

import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { checkAuth, probeKeychainAuth } from './doctor.ts';
import { execText, runWithDeadline } from './proc.ts';
import { getDailyUsage, recordDailyUsage, utcDay } from './store/usage.ts';

export type ClaudeRunner = (
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type ClaudeTest = {
  at: string;
  ok: boolean;
  ms: number;
  costUsd: number;
  reply: string;
  models: string[];
  error?: string;
};

export const TEST_ARGS = [
  '-p',
  'Reply with exactly: OK',
  '--output-format',
  'json',
  '--max-turns',
  '1',
  '--max-budget-usd',
  '0.05',
  '--restricted',
  '--strict-mcp-config',
  '--tools',
  '',
  '--permission-mode',
  'dontAsk',
];
const TIMEOUT_MS = 60_000;

/**
 * The test turn's state and the CLI version cache (these were
 * module-level, reset by a test hook). One per process by default; a test
 * builds its own.
 */
export class ClaudeProbe {
  running = false;
  last: ClaudeTest | null = null;
  version: { at: number; value: string | null } | null = null;
}

/** This process's probe: the UI server's test turn and the page's status read it. */
export const processProbe = new ClaudeProbe();

/** The last test's result, or null. */
export const lastTest = (probe: ClaudeProbe = processProbe) => probe.last;
/** Whether a test is in flight. */
export const testRunning = (probe: ClaudeProbe = processProbe) => probe.running;

/** Run `claude` from PATH in an empty directory, with a deadline. */
export const runClaude: ClaudeRunner = async (args) => {
  const r = await runWithDeadline(['claude', ...args], { cwd: tmpdir(), timeoutMs: TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout, stderr: r.error ?? r.stderr };
};

function cliVersion(probe: ClaudeProbe): string | null {
  const cached = probe.version;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: string | null = null;
  const dirs = (process.env.PATH ?? '').split(':');
  if (dirs.some((d) => d && existsSync(join(d, 'claude')))) {
    try {
      value = execText('claude', ['--version'], { timeoutMs: 5000 });
    } catch {
      value = null;
    }
  }
  probe.version = { at: Date.now(), value };
  return value;
}

export type ClaudeStatus = {
  auth: { mode: 'api_key' | 'subscription' | 'none'; detail: string };
  cli: { version: string | null };
  lastTurn: { kind: 'pulse' | 'session'; id: string; at: string; costUsd: number } | null;
  lastError: { pulseId: number; at: string; error: string } | null;
  today: { costUsd: number; pulses: number; sessions: number };
  test: ClaudeTest | null;
  testRunning: boolean;
  paused: boolean;
  howTo: { subscription: string; apiKey: string };
};

export function claudeStatus(
  db: Db,
  lanternDir: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    keychain?: () => boolean;
    version?: () => string | null;
    probe?: ClaudeProbe;
  } = {},
): ClaudeStatus {
  const probe = opts.probe ?? processProbe;
  const auth = checkAuth(
    opts.env ?? process.env,
    opts.home ?? homedir(),
    opts.keychain ?? probeKeychainAuth,
  );
  const mode = !auth.ok
    ? 'none'
    : /ANTHROPIC_API_KEY/.test(auth.detail)
      ? 'api_key'
      : 'subscription';

  const lastTurn = db
    .prepare(
      `SELECT * FROM (
         SELECT 'pulse' AS kind, CAST(id AS TEXT) AS id, ended_at AS at, cost_usd AS costUsd
           FROM pulses WHERE ended_at IS NOT NULL AND cost_usd > 0 AND status != 'error'
         UNION ALL
         SELECT 'session', id, ended_at, cost_usd
           FROM sessions WHERE ended_at IS NOT NULL AND cost_usd > 0 AND status = 'done'
       ) ORDER BY julianday(at) DESC LIMIT 1`,
    )
    .get() as ClaudeStatus['lastTurn'] | undefined;
  const lastError = db
    .prepare(
      `SELECT id AS pulseId, started_at AS at, error FROM pulses
       WHERE status = 'error' AND error IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get() as ClaudeStatus['lastError'] | undefined;
  const usage = getDailyUsage(db, utcDay());

  return {
    auth: { mode, detail: auth.detail },
    cli: { version: opts.version ? opts.version() : cliVersion(probe) },
    lastTurn: lastTurn ?? null,
    lastError: lastError ?? null,
    today: { costUsd: usage.cost_usd, pulses: usage.pulses, sessions: usage.sessions },
    test: probe.last,
    testRunning: probe.running,
    paused: existsSync(join(lanternDir, 'PAUSED')),
    howTo: {
      subscription: 'claude login',
      apiKey: 'Put ANTHROPIC_API_KEY=… in the .env Lantern runs with, then restart the daemons.',
    },
  };
}

/**
 * Start one test turn in the background. The result arrives in `probe.last`;
 * the page hears of it through the event stream's `claude` area.
 */
export function startClaudeTest(
  db: Db,
  lanternDir: string,
  run: ClaudeRunner = runClaude,
  probe: ClaudeProbe = processProbe,
): { started: boolean; error?: string } {
  if (existsSync(join(lanternDir, 'PAUSED'))) {
    return { started: false, error: 'the kill switch is on — resume Lantern to run a test turn' };
  }
  if (probe.running) return { started: false, error: 'a test turn is already running' };
  probe.running = true;
  const t0 = Date.now();
  run(TEST_ARGS)
    .then(({ code, stdout, stderr }) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const costUsd = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
      if (costUsd > 0) recordDailyUsage(db, { costUsd });
      const ok = code === 0 && parsed?.is_error === false;
      probe.last = {
        at: new Date().toISOString(),
        ok,
        ms: Date.now() - t0,
        costUsd,
        reply: typeof parsed?.result === 'string' ? parsed.result.slice(0, 200) : '',
        models: Object.keys((parsed?.modelUsage as object) ?? {}),
        ...(ok
          ? {}
          : {
              error: (
                stderr.trim() ||
                (typeof parsed?.result === 'string' ? parsed.result : '') ||
                `claude exited ${code}`
              ).slice(0, 500),
            }),
      };
    })
    .catch((e: unknown) => {
      probe.last = {
        at: new Date().toISOString(),
        ok: false,
        ms: Date.now() - t0,
        costUsd: 0,
        reply: '',
        models: [],
        error: e instanceof Error ? e.message : String(e),
      };
    })
    .finally(() => {
      probe.running = false;
    });
  return { started: true };
}
