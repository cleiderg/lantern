/**
 * Integration test for ClaudeCodeHarness.
 *
 * Skipped if neither ANTHROPIC_API_KEY nor ~/.claude/.credentials.json is present,
 * since this test actually calls `claude -p` and incurs real tokens.
 *
 * Run: npm test -- --test-name-pattern claude-code
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { buildDigest } from '../digest.ts';
import { writeMcpConfig } from '../mcp/config.ts';
import { runMigrations } from '../migrate.ts';
import { computeWindow } from '../scheduler.ts';
import { createRunningPulse, finishPulse } from '../store/pulses.ts';
import type { Pulse } from '../types.ts';
import { buildArgs, ClaudeCodeHarness } from './claude-code.ts';

function hasAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}

test('ClaudeCodeHarness: real claude -p completes a pulse with non-zero cost', {
  skip: !hasAuth() ? 'no Claude auth available (set ANTHROPIC_API_KEY or run claude login)' : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-cc-'));
  try {
    const db = openDb(join(dir, 'lantern.db'));
    runMigrations(db);
    const agent = ensureDefaultAgent(db, dir);
    const mcpConfig = writeMcpConfig(dir);

    const now = new Date().toISOString();
    const window = computeWindow(null, now);
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: window.window_start,
      windowEnd: window.window_end,
    });

    const digest = buildDigest(db, agent, window);
    const harness = new ClaudeCodeHarness();

    const handle = await harness.run({
      prompt: `${digest}\n\nRespond only with: "heartbeat.selfcheck: ok"`,
      cwd: agent.workdir,
      tier: 'read_only',
      allowedTools: ['mcp__lantern__*'],
      disallowedTools: [],
      mcpConfig,
      maxTurns: 3,
      timeoutMs: 120_000,
      costCeilingUsd: 0.1,
    });

    const state = await harness.poll(handle.id);

    assert.ok(
      state.status === 'done' || state.status === 'failed',
      `expected done or failed, got ${state.status}`,
    );
    assert.ok(state.costUsd > 0, `expected non-zero cost, got ${state.costUsd}`);
    assert.ok(state.sessionId.length > 0, 'sessionId must be non-empty');
    assert.ok(typeof state.result === 'string', 'result must be a string');

    finishPulse(db, pulseId, {
      status: 'clean',
      summary: state.result.slice(0, 200),
      costUsd: state.costUsd,
      durationMs: state.durationMs,
      sessionId: state.sessionId,
    });

    const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(pulseId) as Pulse;
    assert.ok(pulse.ended_at !== null, 'pulse must be closed');
    assert.ok(pulse.cost_usd > 0, 'pulse must record non-zero cost');
    assert.ok(
      typeof pulse.summary === 'string' && pulse.summary.length > 0,
      'pulse must have summary',
    );

    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── a timeout is charged, not recorded as free ───────────────────
// A fake `claude` on PATH stands in for a turn that never finishes. With no
// result event its real spend is unknown; the most it could be is the
// --max-budget-usd ceiling, so that is what gets charged.

function fakeClaude(dir: string, script: string): Record<string, string> {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

const SPEC = {
  prompt: 'p',
  tier: 'read_only' as const,
  allowedTools: [],
  disallowedTools: [],
  mcpConfig: '/dev/null',
  maxTurns: 1,
  timeoutMs: 300,
  costCeilingUsd: 1.5,
};

test('ClaudeCodeHarness: a timed-out turn with no result is charged the ceiling', {
  timeout: 10000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-fake-claude-'));
  try {
    const env = fakeClaude(dir, 'exec sleep 30');
    const h = new ClaudeCodeHarness();
    const { id } = await h.run({ ...SPEC, cwd: dir, env });
    const state = await h.poll(id);
    assert.equal(state.status, 'timeout');
    assert.equal(state.costUsd, 1.5);
    assert.match(state.result, /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeCodeHarness: a timed-out turn that reported its cost keeps that cost', {
  timeout: 10000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-fake-claude-'));
  try {
    const result = JSON.stringify({ type: 'result', total_cost_usd: 0.42, result: 'partial' });
    const env = fakeClaude(dir, `echo '${result}'\nexec sleep 30`);
    const h = new ClaudeCodeHarness();
    // Long enough that the fake has printed its result before the timeout
    // fires; at 300ms a loaded machine sometimes had not started the shell yet.
    const { id } = await h.run({ ...SPEC, timeoutMs: 2000, cwd: dir, env });
    const state = await h.poll(id);
    assert.equal(state.status, 'timeout');
    assert.equal(state.costUsd, 0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── every spawn is sandboxed ─────────────────────────────────────────────

test('buildArgs: --restricted, --strict-mcp-config and the tier tool list on every spawn', () => {
  const args = buildArgs({ ...SPEC, cwd: '/tmp', tools: ['Bash', 'Read'] }, 'sid');
  assert.ok(args.includes('--restricted'));
  assert.ok(
    args.includes('--strict-mcp-config'),
    "only Lantern's MCP server, never the operator's connectors",
  );
  const i = args.indexOf('--tools');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'Bash,Read');
});

test('buildArgs: a spec with no tool list gets none — `--tools ""`, not the default set', () => {
  const args = buildArgs({ ...SPEC, cwd: '/tmp' }, 'sid');
  assert.equal(args[args.indexOf('--tools') + 1], '');
});

// ── transcripts ──────────────────────────────────────────────────────────

test('ClaudeCodeHarness: every stream line is written to the transcript, untruncated', {
  timeout: 20000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-transcript-'));
  try {
    // ~1.2 MB of events: well past any buffer, pipe or slice limit.
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x'.repeat(1200) }] },
    });
    const result = JSON.stringify({ type: 'result', total_cost_usd: 0.01, result: 'done' });
    const env = fakeClaude(
      dir,
      `i=0; while [ $i -lt 1000 ]; do echo '${line}'; i=$((i+1)); done; echo '${result}'`,
    );
    const transcriptPath = join(dir, 'runs', '3', 'orchestrator.jsonl');
    const h = new ClaudeCodeHarness();
    const { id } = await h.run({ ...SPEC, timeoutMs: 15000, cwd: dir, env, transcriptPath });
    const state = await h.poll(id);
    assert.equal(state.status, 'done');
    const written = readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    assert.equal(written.length, 1001);
    assert.equal(written[0], line);
    assert.equal(written[1000], result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildArgs: an outputSchema becomes --json-schema', () => {
  const schema = { type: 'object', required: ['outcome'] };
  const args = buildArgs({ ...SPEC, cwd: '/tmp', outputSchema: schema }, 'sid');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
  assert.ok(
    !buildArgs({ ...SPEC, cwd: '/tmp' }, 'sid').includes('--json-schema'),
    'none without a schema',
  );
});
