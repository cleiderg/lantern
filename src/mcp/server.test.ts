import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { createRunningPulse } from '../store/pulses.ts';
import type { TicketEvent } from '../types.ts';
import { ALL_TOOL_NAMES } from './tools.ts';

const SERVER_PATH = fileURLToPath(new URL('server.ts', import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────────

type LineReader = { next: (timeoutMs?: number) => Promise<string> };

function spawnServer(
  lanternDir: string,
  tier = 'orchestrator',
  extraEnv: Record<string, string> = {},
): { proc: ChildProcess; reader: LineReader; send: (msg: object) => void } {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, LANTERN_DIR: lanternDir, LANTERN_TIER: tier, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];

  (proc.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const deliver = waiters.shift();
      if (deliver) deliver(line);
      else queue.push(line);
    }
  });

  const reader: LineReader = {
    next: (timeoutMs = 3000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms waiting for MCP response`)),
          timeoutMs,
        );
        const deliver = (line: string) => {
          clearTimeout(timer);
          resolve(line);
        };
        const line = queue.shift();
        if (line !== undefined) deliver(line);
        else waiters.push(deliver);
      }),
  };

  return {
    proc,
    reader,
    send: (msg) => {
      (proc.stdin as NodeJS.WritableStream).write(`${JSON.stringify(msg)}\n`);
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('MCP server initialize handshake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'));

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    const resp = JSON.parse(await reader.next()) as {
      result: {
        serverInfo: { name: string };
        protocolVersion: string;
        capabilities: { tools: object };
      };
    };
    assert.equal(resp.result.serverInfo.name, 'lantern');
    assert.equal(resp.result.protocolVersion, '2024-11-05');
    assert.ok(resp.result.capabilities.tools !== undefined);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server tools/list returns all 14 tools for orchestrator tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'), 'orchestrator');

  try {
    // initialize
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    // initialized notification (no response expected)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // tools/list
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const resp = JSON.parse(await reader.next()) as { result: { tools: Array<{ name: string }> } };

    const names = resp.result.tools.map((t) => t.name);
    assert.equal(names.length, ALL_TOOL_NAMES.length, 'should list all tools');

    for (const expected of ALL_TOOL_NAMES) {
      assert.ok(names.includes(expected), `tool '${expected}' should be listed`);
    }
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server tools/list omits orchestrator-only tools for read_only tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'), 'read_only');

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const resp = JSON.parse(await reader.next()) as { result: { tools: Array<{ name: string }> } };

    const names = resp.result.tools.map((t) => t.name);

    // orchestrator-only tools must not be visible to read_only
    const orchestratorOnly = [
      'observation_record',
      'pulse_finding',
      'staff_ticket',
      'playbook_run',
      'log_query',
    ];
    for (const name of orchestratorOnly) {
      assert.ok(!names.includes(name), `'${name}' should not appear for read_only tier`);
    }

    // 'all' tier tools must still be visible
    const allTierTools = [
      'tickets_search',
      'tickets_get',
      'tickets_create',
      'tickets_close',
      'prior_art',
      'escalate',
    ];
    for (const name of allTierTools) {
      assert.ok(names.includes(name), `'${name}' should appear for read_only tier`);
    }
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server rejects orchestrator-only tool call from read_only session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'), 'read_only');

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pulse_finding', arguments: { action_key: 'test', outcome: 'clean' } },
    });
    const resp = JSON.parse(await reader.next()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };

    assert.equal(resp.result.isError, true);
    assert.ok(
      resp.result.content[0]?.text.includes('orchestrator'),
      'error should mention orchestrator tier',
    );
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server responds to ping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'));

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const resp = JSON.parse(await reader.next()) as { id: number; result: object };

    assert.equal(resp.id, 2);
    assert.deepEqual(resp.result, {});
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server returns error for unknown method', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-test-'));
  initLantern(join(dir, '.lantern'));
  const { proc, reader, send } = spawnServer(join(dir, '.lantern'));

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    send({ jsonrpc: '2.0', id: 2, method: 'nonexistent/method' });
    const resp = JSON.parse(await reader.next()) as { error: { code: number } };

    assert.equal(resp.error.code, -32601);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── event recording: ticket_events carry pulse_id from env ────────────────

test('tickets_create tool writes ticket_events row with the injected pulse_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcp-pulse-'));
  const lanternDir = join(dir, '.lantern');
  initLantern(lanternDir);

  // Create a running pulse in the DB so we have a valid pulse_id to inject
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, lanternDir);
  const pulseId = createRunningPulse(db, {
    agentId: agent.id,
    windowStart: '2026-09-07T09:00:00.000Z',
    windowEnd: '2026-09-07T10:00:00.000Z',
  });
  db.close();

  const { proc, reader, send } = spawnServer(lanternDir, 'orchestrator', {
    LANTERN_AGENT_ID: agent.id,
    LANTERN_PULSE_ID: String(pulseId),
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    });
    await reader.next();

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'tickets_create',
        arguments: {
          kind: 'bug',
          title: 'Test event recording',
          body: 'Verifying pulse_id flows into ticket_events',
          origin: 'agent:self',
        },
      },
    });
    const resp = JSON.parse(await reader.next()) as { result: { isError?: boolean } };
    assert.ok(!resp.result.isError, 'tool call should succeed');

    // Verify the ticket_events row carries the injected pulse_id
    const db2 = openDb(join(lanternDir, 'lantern.db'));
    try {
      const events = db2
        .prepare("SELECT * FROM ticket_events WHERE event = 'created'")
        .all() as TicketEvent[];
      assert.ok(events.length >= 1, 'should have a created event');
      assert.equal(
        events[0]?.pulse_id,
        pulseId,
        'event pulse_id must match the injected LANTERN_PULSE_ID',
      );
    } finally {
      db2.close();
    }
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
