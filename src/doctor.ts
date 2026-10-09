import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { LANTERN_DIR } from './init.ts';
import { execText } from './proc.ts';

export type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
};

/** Lantern runs its TypeScript through Node's type stripping, with no build step; 24 is what's tested. */
const MIN_NODE_MAJOR = 24;

export function checkNodeVersion(nodeVersion: string = process.versions.node): CheckResult {
  const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    label: 'node version',
    ok,
    detail: ok ? `v${nodeVersion}` : `v${nodeVersion} — need >=${MIN_NODE_MAJOR}`,
    fatal: !ok,
  };
}

export function checkSqliteNative(): CheckResult {
  try {
    const db = openDb(':memory:');
    db.close();
    return {
      label: 'better-sqlite3 native',
      ok: true,
      detail: 'native module loads',
      fatal: false,
    };
  } catch (e) {
    return {
      label: 'better-sqlite3 native',
      ok: false,
      detail: `failed to load: ${e instanceof Error ? e.message : String(e)}`,
      fatal: true,
    };
  }
}

export function checkLanternDir(lanternDir: string = LANTERN_DIR): CheckResult {
  const ok = existsSync(lanternDir);
  return {
    label: '~/.lantern directory',
    ok,
    detail: ok ? lanternDir : `${lanternDir} not found — run 'lantern init'`,
    fatal: !ok,
  };
}

export function checkMigrationsApplied(
  migrationsDir: string,
  lanternDir: string = LANTERN_DIR,
): CheckResult {
  const dbPath = join(lanternDir, 'lantern.db');
  if (!existsSync(dbPath)) {
    return {
      label: 'migrations applied',
      ok: false,
      detail: `lantern.db not found at ${dbPath} — run 'lantern init'`,
      fatal: true,
    };
  }
  try {
    const db = openDb(dbPath);
    let applied: Set<string>;
    try {
      applied = new Set(
        (db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[]).map(
          (r) => r.filename,
        ),
      );
    } finally {
      db.close();
    }

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length > 0) {
      return {
        label: 'migrations applied',
        ok: false,
        detail: `pending: ${pending.join(', ')} — run 'lantern init'`,
        fatal: true,
      };
    }
    return {
      label: 'migrations applied',
      ok: true,
      detail: `${applied.size} applied (${files.join(', ')})`,
      fatal: false,
    };
  } catch (e) {
    return {
      label: 'migrations applied',
      ok: false,
      detail: `could not read DB: ${e instanceof Error ? e.message : String(e)}`,
      fatal: true,
    };
  }
}

/** Keychain service name Claude Code stores subscription credentials under on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * True when macOS's login Keychain holds a `claude login` credential.
 *
 * `claude login` writes ~/.claude/.credentials.json on Linux but uses the
 * Keychain on darwin, so the file probe alone is a false negative there.
 * Deliberately omits `security`'s -w flag: we want existence, never the secret.
 * Any non-darwin platform returns false and leaves the file probe in charge.
 */
export function probeKeychainAuth(platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false;
  try {
    execText('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { timeoutMs: 8000 });
    return true;
  } catch {
    // Exit 44 (item not found), no keychain, or locked — all "not detected".
    return false;
  }
}

/**
 * Accepts either ANTHROPIC_API_KEY (pay-per-token) or Claude Pro subscription
 * credentials written by `claude login` — the ~/.claude/.credentials.json file
 * on Linux, the login Keychain on macOS.
 * Non-fatal if neither is detected — the real failure surfaces when claude -p runs.
 */
export function checkAuth(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  keychainProbe: () => boolean = probeKeychainAuth,
): CheckResult {
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key === 'string' && key.length > 0) {
    return { label: 'auth', ok: true, detail: 'ANTHROPIC_API_KEY set', fatal: false };
  }

  const credPath = join(homeDir, '.claude', '.credentials.json');
  if (existsSync(credPath)) {
    return {
      label: 'auth',
      ok: true,
      detail: 'Claude Pro subscription — credentials found (claude login)',
      fatal: false,
    };
  }

  if (keychainProbe()) {
    return {
      label: 'auth',
      ok: true,
      detail: 'Claude Pro subscription — credentials found in macOS Keychain (claude login)',
      fatal: false,
    };
  }

  return {
    label: 'auth',
    ok: false,
    detail: 'no auth detected — set ANTHROPIC_API_KEY or run `claude login` for Claude Pro',
    fatal: false,
  };
}

export function checkClaudeCli(pathEnv: string = process.env.PATH ?? ''): CheckResult {
  const dirs = pathEnv.split(':').filter(Boolean);
  const claudePath = dirs.map((d) => join(d, 'claude')).find((p) => existsSync(p));

  if (claudePath === undefined) {
    return {
      label: 'claude CLI',
      ok: false,
      detail: '`claude` not found on PATH — install Claude Code (https://claude.ai/code)',
      fatal: true,
    };
  }

  try {
    const raw = execText(claudePath, ['--version'], { timeoutMs: 8000 });
    return { label: 'claude CLI', ok: true, detail: raw, fatal: false };
  } catch {
    // Present on PATH but --version failed — still counts as found.
    return {
      label: 'claude CLI',
      ok: true,
      detail: `found at ${claudePath} (version unavailable)`,
      fatal: false,
    };
  }
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export type DoctorOptions = {
  lanternDir?: string;
  migrationsDir?: string;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  nodeVersion?: string;
  homeDir?: string;
  keychainProbe?: () => boolean;
};

export function runDoctor(opts: DoctorOptions = {}): { checks: CheckResult[]; ok: boolean } {
  const lanternDir = opts.lanternDir ?? LANTERN_DIR;
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const env = opts.env ?? process.env;
  const pathEnv = opts.pathEnv ?? env.PATH ?? '';
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const homeDir = opts.homeDir ?? homedir();

  const checks: CheckResult[] = [
    checkNodeVersion(nodeVersion),
    checkSqliteNative(),
    checkLanternDir(lanternDir),
    checkMigrationsApplied(migrationsDir, lanternDir),
    checkAuth(env, homeDir, opts.keychainProbe ?? probeKeychainAuth),
    checkClaudeCli(pathEnv),
  ];

  const ok = checks.every((c) => c.ok || !c.fatal);
  return { checks, ok };
}

/** Format check results as a human-readable table for terminal output. */
export function formatDoctor(checks: CheckResult[]): string {
  const rows = checks.map((c) => {
    const badge = c.ok ? '[ok]  ' : '[FAIL]';
    return `  ${badge}  ${c.label.padEnd(24)}  ${c.detail}`;
  });
  const allOk = checks.every((c) => c.ok || !c.fatal);
  const failCount = checks.filter((c) => !c.ok && c.fatal).length;
  const summary = allOk
    ? 'lantern doctor: all checks passed'
    : `lantern doctor: ${failCount} check(s) failed`;
  return `${rows.join('\n')}\n${summary}\n`;
}
