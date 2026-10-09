import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkAuth,
  checkClaudeCli,
  checkLanternDir,
  checkMigrationsApplied,
  checkNodeVersion,
  formatDoctor,
  probeKeychainAuth,
  runDoctor,
} from './doctor.ts';
import { initLantern } from './init.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-doctor-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── checkNodeVersion ─────────────────────────────────────────────────────────

test('checkNodeVersion: current version passes', () => {
  const r = checkNodeVersion(process.versions.node);
  assert.ok(r.ok, `should pass on current node (${process.versions.node})`);
  assert.equal(r.fatal, false);
});

test('checkNodeVersion: v22 fails fatally — no type stripping we have tested', () => {
  const r = checkNodeVersion('22.12.0');
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.detail, /need >=24/);
});

test('checkNodeVersion: v24 passes', () => {
  const r = checkNodeVersion('24.0.0');
  assert.ok(r.ok);
});

// ─── checkLanternDir ─────────────────────────────────────────────────────────────

test('checkLanternDir: missing dir fails fatally', () => {
  const r = checkLanternDir('/nonexistent/path/that/does/not/exist');
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.detail, /lantern init/);
});

test('checkLanternDir: existing dir passes', () => {
  withTmpDir((dir) => {
    const r = checkLanternDir(dir);
    assert.ok(r.ok);
    assert.equal(r.fatal, false);
  });
});

// ─── checkMigrationsApplied ───────────────────────────────────────────────────

test('checkMigrationsApplied: no DB fails fatally', () => {
  withTmpDir((dir) => {
    // lanternDir exists but lantern.db does not
    const r = checkMigrationsApplied(MIGRATIONS_DIR, dir);
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
    assert.match(r.detail, /lantern init/);
  });
});

test('checkMigrationsApplied: after initLantern all migrations applied', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const r = checkMigrationsApplied(MIGRATIONS_DIR, lanternDir);
    assert.ok(r.ok, `detail: ${r.detail}`);
    assert.match(r.detail, /001_init\.sql/);
  });
});

test('checkMigrationsApplied: unrun migration fails fatally', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);

    // Write a new migration file that hasn't been applied
    const extraMigration = join(dir, 'migrations');
    mkdirSync(extraMigration);
    writeFileSync(join(extraMigration, '002_extra.sql'), '-- noop');

    const r = checkMigrationsApplied(extraMigration, lanternDir);
    assert.equal(r.ok, false);
    assert.match(r.detail, /pending/);
  });
});

// ─── checkAuth ────────────────────────────────────────────────────────────────

test('checkAuth: API key passes', () => {
  withTmpDir((dir) => {
    const r = checkAuth({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }, dir);
    assert.ok(r.ok);
    assert.equal(r.fatal, false);
    assert.match(r.detail, /ANTHROPIC_API_KEY/);
  });
});

test('checkAuth: Claude Pro credentials file passes', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', '.credentials.json'), '{"token":"test"}');
    const r = checkAuth({}, dir, () => {
      throw new Error('Keychain should not be probed when the credentials file exists');
    });
    assert.ok(r.ok);
    assert.equal(r.fatal, false);
    assert.match(r.detail, /Claude Pro/);
  });
});

test('checkAuth: no auth is non-fatal warning', () => {
  withTmpDir((dir) => {
    const r = checkAuth({}, dir, () => false);
    assert.equal(r.ok, false);
    assert.equal(r.fatal, false, 'should be non-fatal — real failure surfaces when claude -p runs');
    assert.match(r.detail, /claude login/);
  });
});

test('checkAuth: empty API key falls through to credential check', () => {
  withTmpDir((dir) => {
    const r = checkAuth({ ANTHROPIC_API_KEY: '' }, dir, () => false);
    assert.equal(r.ok, false); // no creds file either
    assert.equal(r.fatal, false);
  });
});

test('checkAuth: macOS Keychain credentials pass when no file exists', () => {
  withTmpDir((dir) => {
    const r = checkAuth({}, dir, () => true);
    assert.ok(r.ok, 'a `claude login` on darwin stores creds in the Keychain, not a file');
    assert.equal(r.fatal, false);
    assert.match(r.detail, /Keychain/);
  });
});

test('checkAuth: API key wins without probing the Keychain', () => {
  withTmpDir((dir) => {
    const r = checkAuth({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }, dir, () => {
      throw new Error('Keychain should not be probed when ANTHROPIC_API_KEY is set');
    });
    assert.ok(r.ok);
    assert.match(r.detail, /ANTHROPIC_API_KEY/);
  });
});

test('probeKeychainAuth: non-darwin platforms never probe', () => {
  assert.equal(probeKeychainAuth('linux'), false);
  assert.equal(probeKeychainAuth('win32'), false);
});

// ─── checkClaudeCli ───────────────────────────────────────────────────────────

test('checkClaudeCli: empty PATH fails fatally', () => {
  const r = checkClaudeCli('');
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.detail, /not found on PATH/);
});

test('checkClaudeCli: PATH without claude fails fatally', () => {
  withTmpDir((dir) => {
    // dir exists but has no `claude` binary
    const r = checkClaudeCli(dir);
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
  });
});

test('checkClaudeCli: claude on PATH passes and returns version string', () => {
  withTmpDir((dir) => {
    // Create a fake `claude` script that prints a version
    const claudePath = join(dir, 'claude');
    writeFileSync(claudePath, '#!/bin/sh\necho "9.9.9 (Claude Code)"', { mode: 0o755 });

    const r = checkClaudeCli(dir);
    assert.ok(r.ok, `detail: ${r.detail}`);
    assert.match(r.detail, /9\.9\.9/);
    assert.equal(r.fatal, false);
  });
});

// ─── runDoctor + formatDoctor ─────────────────────────────────────────────────

test('runDoctor: no auth is a non-fatal warning → ok=true', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const { ok, checks } = runDoctor({
      lanternDir,
      migrationsDir: MIGRATIONS_DIR,
      env: {}, // no API key
      homeDir: dir, // no .claude/.credentials.json here
      keychainProbe: () => false, // and nothing in the macOS Keychain
      pathEnv: process.env.PATH ?? '',
    });
    // Auth failure is non-fatal; doctor still passes overall (claude is on PATH)
    const authCheck = checks.find((c) => c.label === 'auth');
    assert.ok(authCheck !== undefined);
    assert.equal(authCheck.fatal, false);
    // ok reflects whether any fatal check failed — auth is not fatal
    assert.equal(ok, true);
  });
});

test('runDoctor: missing claude on PATH → ok=false', () => {
  withTmpDir((dir) => {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const { ok } = runDoctor({
      lanternDir,
      migrationsDir: MIGRATIONS_DIR,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      homeDir: dir,
      pathEnv: '/nonexistent/path', // claude not here
    });
    assert.equal(ok, false);
  });
});

test('formatDoctor: ok checks use [ok] badge, failed use [FAIL]', () => {
  const output = formatDoctor([
    { label: 'thing a', ok: true, detail: 'great', fatal: false },
    { label: 'thing b', ok: false, detail: 'broken', fatal: true },
  ]);
  assert.match(output, /\[ok\]/);
  assert.match(output, /\[FAIL\]/);
  assert.match(output, /1 check\(s\) failed/);
});

test('formatDoctor: all ok → summary says all checks passed', () => {
  const output = formatDoctor([
    { label: 'a', ok: true, detail: 'fine', fatal: false },
    { label: 'b', ok: true, detail: 'fine', fatal: false },
  ]);
  assert.match(output, /all checks passed/);
});
