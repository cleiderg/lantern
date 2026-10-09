import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDeadMan } from './deadman.ts';
import type { Agent } from './types.ts';

function agentWith(overrides: Partial<Agent>): Agent {
  return {
    id: 'a1',
    display_name: 'Agent',
    config_path: 'agents/a1.agent.md',
    mission: 'watch',
    heartbeat_seconds: 3600,
    max_children: 1,
    state: 'running',
    workdir: '/tmp',
    paused_reason: null,
    last_pulse_at: null,
    next_pulse_at: null,
    created_at: '2026-09-01 00:00:00',
    updated_at: '2026-09-01 00:00:00',
    ...overrides,
  };
}

test('checkDeadMan: not stale just under 3x heartbeat since last_pulse_at', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: '2026-09-01 00:00:00' });
  const now = new Date('2026-09-01T00:02:59Z').getTime(); // 179s — under 180s threshold
  const result = checkDeadMan(agent, now);
  assert.equal(result.stale, false);
  assert.equal(result.thresholdSeconds, 180);
});

test('checkDeadMan: stale just over 3x heartbeat since last_pulse_at', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: '2026-09-01 00:00:00' });
  const now = new Date('2026-09-01T00:03:01Z').getTime(); // 181s — over 180s threshold
  const result = checkDeadMan(agent, now);
  assert.equal(result.stale, true);
  assert.ok(result.staleSeconds > result.thresholdSeconds);
});

test('checkDeadMan: falls back to created_at when the agent has never pulsed', () => {
  const agent = agentWith({
    heartbeat_seconds: 60,
    last_pulse_at: null,
    created_at: '2026-09-01 00:00:00',
  });
  const now = new Date('2026-09-01T00:03:01Z').getTime();
  const result = checkDeadMan(agent, now);
  assert.equal(result.referenceAt, '2026-09-01 00:00:00');
  assert.equal(result.stale, true);
});

test('checkDeadMan: a freshly created agent within the threshold is not stale', () => {
  const agent = agentWith({
    heartbeat_seconds: 3600,
    last_pulse_at: null,
    created_at: '2026-09-01 00:00:00',
  });
  const now = new Date('2026-09-01T00:05:00Z').getTime(); // 5 minutes old, threshold is 3h
  const result = checkDeadMan(agent, now);
  assert.equal(result.stale, false);
});

test('checkDeadMan: custom multiplier is respected', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: '2026-09-01 00:00:00' });
  const now = new Date('2026-09-01T00:01:30Z').getTime(); // 90s
  assert.equal(checkDeadMan(agent, now, 1).stale, true, '90s > 1× 60s threshold');
  assert.equal(checkDeadMan(agent, now, 3).stale, false, '90s < 3× 60s threshold');
});

// the pulse creators stamp last_pulse_at with toISOString(), which already
// carries a 'Z'. Appending another produced NaN and the alert could never fire.
test('checkDeadMan: stale with an ISO last_pulse_at, the format pulses actually write', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: '2026-09-01T00:00:00.000Z' });
  const now = new Date('2026-09-01T00:03:01Z').getTime();
  const result = checkDeadMan(agent, now);
  assert.equal(result.staleSeconds, 181);
  assert.equal(result.stale, true);
});

test('checkDeadMan: not stale with a fresh ISO last_pulse_at', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: '2026-09-01T00:00:00.000Z' });
  const now = new Date('2026-09-01T00:02:59Z').getTime();
  assert.equal(checkDeadMan(agent, now).stale, false);
});

test('checkDeadMan: an unparseable timestamp is reported stale, not silently fresh', () => {
  const agent = agentWith({ heartbeat_seconds: 60, last_pulse_at: 'garbage' });
  assert.equal(checkDeadMan(agent, Date.now()).stale, true);
});
