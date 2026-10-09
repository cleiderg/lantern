import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mcpConfigJson, writeSessionMcpConfig } from './config.ts';

type Config = {
  mcpServers: { lantern: { command: string; args: string[]; env: Record<string, string> } };
};

function parse(json: string): Config {
  return JSON.parse(json) as Config;
}

// The no-env config is the human attach file `lantern init` writes. The server
// now fails closed to read_only, so the human's tier must be explicit —
// A plain session must be able to link tickets, which read_only cannot.
test('mcpConfigJson: the human attach config names the orchestrator tier explicitly', () => {
  const cfg = parse(mcpConfigJson('/tmp/lantern-x'));
  assert.deepEqual(cfg.mcpServers.lantern.env, {
    LANTERN_DIR: '/tmp/lantern-x',
    LANTERN_TIER: 'orchestrator',
  });
  assert.equal(
    cfg.mcpServers.lantern.command,
    process.execPath,
    'exact node binary, no PATH lookup',
  );
});

test('writeSessionMcpConfig: per-invocation files do not share a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-mcpcfg-'));
  try {
    const a = writeSessionMcpConfig(dir, 'pulse-1', { LANTERN_DIR: dir, LANTERN_PULSE_ID: '1' });
    const b = writeSessionMcpConfig(dir, 'pulse-2', { LANTERN_DIR: dir, LANTERN_PULSE_ID: '2' });
    assert.notEqual(a, b, 'concurrent pulses must not race on one config file');
    assert.equal(parse(readFileSync(a, 'utf8')).mcpServers.lantern.env.LANTERN_PULSE_ID, '1');
    assert.equal(parse(readFileSync(b, 'utf8')).mcpServers.lantern.env.LANTERN_PULSE_ID, '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
