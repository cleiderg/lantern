import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { ClaudeProbe, type ClaudeRunner, claudeStatus, startClaudeTest } from './claude-status.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { createRunningPulse, finishPulse } from './store/pulses.ts';
import { getDailyUsage, utcDay } from './store/usage.ts';

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-claude-status-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, dir);
  // Its own probe: no state shared with other tests or the process.
  const probe = new ClaudeProbe();
  return {
    lanternDir,
    db,
    agent,
    probe,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const reply =
  (json: object): ClaudeRunner =>
  async () => ({ code: 0, stdout: JSON.stringify(json), stderr: '' });

test('claudeStatus: auth mode, CLI version, last successful turn', () => {
  const w = world();
  try {
    const p = createRunningPulse(w.db, { agentId: w.agent.id, windowStart: '', windowEnd: '' });
    finishPulse(w.db, p, { status: 'acted', costUsd: 0.2 });
    const s = claudeStatus(w.db, w.lanternDir, {
      probe: w.probe,
      env: { ANTHROPIC_API_KEY: 'sk-test-not-shown' },
      version: () => '2.1.286 (Claude Code)',
    });
    assert.equal(s.auth.mode, 'api_key');
    assert.doesNotMatch(JSON.stringify(s), /sk-test/, 'the key itself is never returned');
    assert.equal(s.cli.version, '2.1.286 (Claude Code)');
    assert.equal(s.lastTurn?.kind, 'pulse');
    assert.equal(s.lastTurn?.id, String(p));
    assert.equal(s.today.costUsd, 0.2, 'the pulse counts in spend today');
    const none = claudeStatus(w.db, w.lanternDir, {
      probe: w.probe,
      env: {},
      home: w.lanternDir,
      keychain: () => false,
      version: () => null,
    });
    assert.equal(none.auth.mode, 'none');
    assert.equal(none.cli.version, null);
  } finally {
    w.cleanup();
  }
});

test('startClaudeTest: one sandboxed turn, its cost counted, the result kept; one at a time', async () => {
  const w = world();
  try {
    let args: string[] = [];
    const runner: ClaudeRunner = async (a) => {
      args = a;
      await new Promise((r) => setTimeout(r, 20));
      return reply({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'OK',
        total_cost_usd: 0.013,
        duration_ms: 1700,
        modelUsage: { 'claude-opus-5-5': {} },
      })(a);
    };
    const first = startClaudeTest(w.db, w.lanternDir, runner, w.probe);
    assert.deepEqual(first, { started: true });
    assert.equal(
      startClaudeTest(w.db, w.lanternDir, runner, w.probe).started,
      false,
      'one at a time',
    );
    await new Promise((r) => setTimeout(r, 60));
    const t = w.probe.last;
    assert.equal(t?.ok, true);
    assert.equal(t?.reply, 'OK');
    assert.deepEqual(t?.models, ['claude-opus-5-5']);
    assert.equal(getDailyUsage(w.db, utcDay()).cost_usd, 0.013, 'Law 7: the test turn is spend');
    for (const flag of ['--restricted', '--strict-mcp-config', '--max-turns', '--max-budget-usd']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools at all');
  } finally {
    w.cleanup();
  }
});

test('startClaudeTest: refused while the kill switch is on; a failure is reported, not thrown', async () => {
  const w = world();
  try {
    writeFileSync(join(w.lanternDir, 'PAUSED'), '');
    const r = startClaudeTest(w.db, w.lanternDir, reply({}), w.probe);
    assert.equal(r.started, false);
    assert.match(r.error ?? '', /kill switch/);
    rmSync(join(w.lanternDir, 'PAUSED'));
    startClaudeTest(
      w.db,
      w.lanternDir,
      async () => ({ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }),
      w.probe,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(w.probe.last?.ok, false);
    assert.match(w.probe.last?.error ?? '', /Invalid API key/);
  } finally {
    w.cleanup();
  }
});
