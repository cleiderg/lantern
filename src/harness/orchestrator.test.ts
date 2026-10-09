import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeHarness } from '../../test/support/fake-harness.ts';
import { ensureDefaultAgent } from '../agent.ts';
import { loadAgentConfig } from '../agent-config.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { createRunningPulse, getPulseFindings } from '../store/pulses.ts';
import type { Pulse } from '../types.ts';
import { runOrchestratorTurn } from './orchestrator.ts';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-orch-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { db, dir, agent };
}

test('pulse writes a pulses row with status, cost, duration, and summary', async () => {
  const { db, dir, agent } = makeDb();

  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  const harness = new FakeHarness({
    result: 'No issues found this pulse.',
    costUsd: 0.05,
    numTurns: 3,
  });

  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# Digest\nMission: test',
    lanternDir: dir,
    harness,
  });

  assert.notEqual(result.status, 'error');
  assert.equal(typeof result.summary, 'string');
  assert.ok(result.summary.length > 0);
  assert.equal(result.costUsd, 0.05);
  assert.ok(result.durationMs >= 0);

  const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(pulseId) as Pulse;
  assert.ok(pulse.ended_at !== null, 'pulse was closed');
  assert.notEqual(pulse.status, 'running');
  assert.equal(pulse.cost_usd, 0.05);
  assert.ok(pulse.duration_ms !== null && pulse.duration_ms >= 0);
  assert.ok(typeof pulse.summary === 'string' && pulse.summary.length > 0);

  db.close();
  rmSync(dir, { recursive: true });
});

test('exceeding cost ceiling records error pulse and does not retry', async () => {
  const { db, dir, agent } = makeDb();

  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  const harness = new FakeHarness({
    result: 'Did a lot of work.',
    costUsd: 2.0, // over the 1.5 ceiling
    numTurns: 30,
  });

  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# Digest',
    lanternDir: dir,
    harness,
    costCeilingUsd: 1.5,
  });

  assert.equal(result.status, 'error');
  assert.match(result.summary, /ceiling/);

  const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(pulseId) as Pulse;
  assert.equal(pulse.status, 'error');
  assert.match(pulse.error ?? '', /ceiling/);
  assert.equal(harness.callCount(), 1, 'only one attempt — no retry');

  db.close();
  rmSync(dir, { recursive: true });
});

test('harness failure records error pulse', async () => {
  const { db, dir, agent } = makeDb();

  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  const harness = new FakeHarness({ result: 'subprocess crashed', isError: true });

  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# Digest',
    lanternDir: dir,
    harness,
  });

  assert.equal(result.status, 'error');

  const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(pulseId) as Pulse;
  assert.equal(pulse.status, 'error');

  db.close();
  rmSync(dir, { recursive: true });
});

test('turn that writes no own findings gets daemon-written skipped finding', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  // FakeHarness never calls MCP tools, so no pulse_findings written by the turn.
  const harness = new FakeHarness({ result: 'heartbeat.selfcheck: daemon healthy', costUsd: 0 });
  await runOrchestratorTurn({ db, agent, pulseId, digest: '# Digest', lanternDir: dir, harness });

  const findings = getPulseFindings(db, pulseId);
  assert.ok(findings.length >= 1, 'at least one finding per pulse');
  assert.equal(findings[0]?.action_key, 'heartbeat.selfcheck');
  assert.equal(findings[0]?.outcome, 'skipped', 'no findings → skipped, not clean');
  assert.equal(findings[0]?.pulse_id, pulseId);

  db.close();
  rmSync(dir, { recursive: true });
});

test('turn that writes own finding via MCP does not get a daemon-written duplicate', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  // Simulate the orchestrator calling pulse_finding via MCP
  const harness = new FakeHarness({
    result: 'done',
    costUsd: 0,
    onRun: () => {
      db.prepare(
        `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail)
         VALUES (?, 'heartbeat.selfcheck', 'clean', 'all checks passed')`,
      ).run(pulseId);
    },
  });
  await runOrchestratorTurn({ db, agent, pulseId, digest: '# Digest', lanternDir: dir, harness });

  const findings = getPulseFindings(db, pulseId);
  assert.equal(findings.length, 1, 'exactly one finding — no daemon-written duplicate');
  assert.equal(findings[0]?.outcome, 'clean');

  db.close();
  rmSync(dir, { recursive: true });
});

test('error pulse also writes a pulse_findings row with outcome=error', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  const harness = new FakeHarness({ result: 'done', costUsd: 99 }); // way over ceiling
  await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# Digest',
    lanternDir: dir,
    harness,
    costCeilingUsd: 1.5,
  });

  const findings = getPulseFindings(db, pulseId);
  assert.ok(findings.length >= 1);
  assert.equal(findings[0]?.outcome, 'error');
  assert.match(findings[0]?.detail ?? '', /ceiling/);

  db.close();
  rmSync(dir, { recursive: true });
});

test('result text saying "escalated" does not make a pulse escalated', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });
  // The classic false-positive: prose mentions escalation but no tool was called
  const harness = new FakeHarness({ result: 'I escalated to the human.', costUsd: 0 });
  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# D',
    lanternDir: dir,
    harness,
  });
  assert.notEqual(result.status, 'escalated', 'text must never be the control path');
  // And it is not `clean` either: this turn recorded no verified finding, so the
  // pulse verified nothing (skipped, not clean).
  assert.equal(result.status, 'skipped');
  db.close();
  rmSync(dir, { recursive: true });
});

test('a pulse is clean only when a finding proves an action actually ran', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });
  // Simulate the turn calling pulse_finding with a real 'clean' outcome.
  const harness = new FakeHarness({
    result: 'checked the daemon, all healthy',
    costUsd: 0,
    onRun: () => {
      db.prepare(
        `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail)
         VALUES (?, 'heartbeat.selfcheck', 'clean', 'daemon responded')`,
      ).run(pulseId);
    },
  });
  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# D',
    lanternDir: dir,
    harness,
  });
  assert.equal(result.status, 'clean');
  db.close();
  rmSync(dir, { recursive: true });
});

test('a pulse whose only finding is skipped is skipped, not clean', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });
  // What pulse #3 did live: the turn recorded its own finding, honestly skipped.
  const harness = new FakeHarness({
    result: 'could not verify daemon health — no playbook for heartbeat.selfcheck',
    costUsd: 0,
    onRun: () => {
      db.prepare(
        `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail)
         VALUES (?, 'heartbeat.selfcheck', 'skipped', 'unknown playbook key')`,
      ).run(pulseId);
    },
  });
  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# D',
    lanternDir: dir,
    harness,
  });
  assert.equal(
    result.status,
    'skipped',
    'status must not claim coverage the findings say was never achieved',
  );
  // The honest finding is preserved, not overwritten by a daemon duplicate.
  const findings = getPulseFindings(db, pulseId);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.outcome, 'skipped');
  db.close();
  rmSync(dir, { recursive: true });
});

test('an escalating pulse stays escalated even with no verified coverage', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });
  // Pulse #2's live shape: skipped finding AND an escalation. The escalation is
  // the signal a human needs, so it wins the status.
  const harness = new FakeHarness({
    result: 'asked the operator how to do the health check',
    costUsd: 0,
    onRun: () => {
      db.prepare(
        `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail)
         VALUES (?, 'heartbeat.selfcheck', 'skipped', 'no playbook')`,
      ).run(pulseId);
      db.prepare(
        `INSERT INTO escalations (agent_id, pulse_id, severity, question)
         VALUES (?, ?, 'decide', 'how should the health check work?')`,
      ).run(agent.id, pulseId);
    },
  });
  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# D',
    lanternDir: dir,
    harness,
  });
  assert.equal(result.status, 'escalated');
  db.close();
  rmSync(dir, { recursive: true });
});

test('status is escalated when an escalations row exists for the pulse', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });
  // Simulate MCP tool call that wrote an escalation row before poll() returns
  const harness = new FakeHarness({
    result: 'done',
    costUsd: 0,
    onRun: () => {
      db.prepare(
        `INSERT INTO escalations (agent_id, pulse_id, severity, question)
         VALUES (?, ?, 'fyi', 'confirm?')`,
      ).run(agent.id, pulseId);
    },
  });
  const result = await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: '# D',
    lanternDir: dir,
    harness,
  });
  assert.equal(result.status, 'escalated');
  db.close();
  rmSync(dir, { recursive: true });
});

test('orchestrator writes a per-pulse MCP config with LANTERN_PULSE_ID and LANTERN_AGENT_ID', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });

  const harness = new FakeHarness({ result: 'ok', costUsd: 0 });
  await runOrchestratorTurn({ db, agent, pulseId, digest: '# D', lanternDir: dir, harness });

  const configPath = join(dir, 'mcp', `pulse-${pulseId}.json`);
  const { existsSync, readFileSync } = await import('node:fs');
  assert.ok(existsSync(configPath), 'per-pulse mcp config written');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: { lantern: { env: Record<string, string> } };
  };
  assert.equal(cfg.mcpServers.lantern.env.LANTERN_PULSE_ID, String(pulseId));
  assert.equal(cfg.mcpServers.lantern.env.LANTERN_AGENT_ID, agent.id);
  assert.equal(cfg.mcpServers.lantern.env.LANTERN_TIER, 'orchestrator');

  db.close();
  rmSync(dir, { recursive: true });
});

test('orchestrator passes systemPromptFile pointing at the persona', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });

  const harness = new FakeHarness({ result: 'ok', costUsd: 0 });
  await runOrchestratorTurn({ db, agent, pulseId, digest: '# D', lanternDir: dir, harness });

  const spec = harness.lastSpec();
  assert.ok(spec !== undefined);
  assert.ok(spec.systemPromptFile !== undefined, 'systemPromptFile must be set');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(spec.systemPromptFile), 'persona file must exist on disk');

  db.close();
  rmSync(dir, { recursive: true });
});

test('orchestrator passes disallowedTools for read_only tier', async () => {
  const { db, dir, agent } = makeDb();
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-26T09:00:00.000Z',
    windowEnd: '2026-09-26T10:00:00.000Z',
  });

  const harness = new FakeHarness({ result: 'ok', costUsd: 0 });
  await runOrchestratorTurn({ db, agent, pulseId, digest: '# D', lanternDir: dir, harness });

  const spec = harness.lastSpec();
  assert.ok(spec !== undefined);
  assert.equal(spec.tier, 'read_only');
  // write surface must be in disallowedTools, not just absent from allowedTools
  assert.ok(spec.disallowedTools.includes('Write'), 'Write must be disallowed');
  assert.ok(spec.disallowedTools.includes('Edit'), 'Edit must be disallowed');
  assert.ok(spec.disallowedTools.includes('Agent'), 'Agent must be disallowed');

  db.close();
  rmSync(dir, { recursive: true });
});

test('FakeHarness records the spec it was called with', async () => {
  const { db, dir, agent } = makeDb();
  const harness = new FakeHarness({ result: 'done', costUsd: 0 });
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-05T09:00:00.000Z',
    windowEnd: '2026-09-05T10:00:00.000Z',
  });

  await runOrchestratorTurn({
    db,
    agent,
    pulseId,
    digest: 'the digest text',
    lanternDir: dir,
    harness,
  });

  const spec = harness.lastSpec();
  assert.ok(spec !== undefined);
  assert.equal(spec.prompt, 'the digest text');
  assert.equal(spec.tier, 'read_only');
  assert.equal(spec.maxTurns, 30);

  db.close();
  rmSync(dir, { recursive: true });
});

// the turn's persona comes from the agent's .agent.md when there is one.
test('runOrchestratorTurn: the persona handed to the harness carries the config body', async () => {
  const { db, dir, agent } = makeDb();
  const config = loadAgentConfig(
    fileURLToPath(new URL('../../test/fixtures/agents/lloyd.agent.md', import.meta.url)),
  );
  const pulseId = createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' });
  const harness = new FakeHarness({ result: 'ok' });
  await runOrchestratorTurn({ db, agent, pulseId, digest: 'd', lanternDir: dir, harness, config });
  const persona = readFileSync(harness.lastSpec()?.systemPromptFile ?? '', 'utf8');
  assert.match(persona, /Engineering manager for this codebase\./);
  assert.match(persona, /Never push to main; never force-push\./);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
