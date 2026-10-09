import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyJitter,
  type Clock,
  computeWindow,
  FIRST_WINDOW_LOOKBACK_MS,
  type PulseWindow,
  Scheduler,
  START_DELAY_MS,
} from './scheduler.ts';

// ── applyJitter ───────────────────────────────────────────────────────────────

test('applyJitter stays within ±10% of heartbeat over 1000 samples', () => {
  const hbMs = 3600_000;
  const lo = hbMs * 0.9;
  const hi = hbMs * 1.1;
  for (let i = 0; i < 1000; i++) {
    const result = applyJitter(hbMs);
    assert.ok(result >= lo, `jitter too low: ${result}`);
    assert.ok(result <= hi, `jitter too high: ${result}`);
  }
});

test('applyJitter with rng=0 returns 90% of heartbeat', () => {
  // rng=0 → (0 * 2 - 1) * variance = -variance → heartbeatMs - variance = 0.9 * heartbeatMs
  const hbMs = 3600_000;
  assert.equal(
    applyJitter(hbMs, () => 0),
    Math.round(hbMs * 0.9),
  );
});

test('applyJitter with rng=1 returns 110% of heartbeat', () => {
  // rng=1 → (1 * 2 - 1) * variance = +variance → heartbeatMs + variance = 1.1 * heartbeatMs
  const hbMs = 3600_000;
  assert.equal(
    applyJitter(hbMs, () => 1),
    Math.round(hbMs * 1.1),
  );
});

// ── computeWindow ─────────────────────────────────────────────────────────────

test('computeWindow uses last window end as start', () => {
  const last = '2024-01-01T10:00:00.000Z';
  const now = '2024-01-01T16:00:00.000Z';
  const w = computeWindow(last, now);
  assert.equal(w.window_start, last);
  assert.equal(w.window_end, now);
});

test('computeWindow: with no prior pulse the first window looks back 24 h, not to 1970', () => {
  const now = '2024-01-01T12:00:00.000Z';
  const w = computeWindow(null, now);
  assert.equal(w.window_start, '2023-12-31T12:00:00.000Z');
  assert.equal(w.window_end, now);
});

// ── Scheduler fake-clock tests ────────────────────────────────────────────────

/** Minimal fake clock: accumulates callbacks without running them. */
function makeFakeClock(
  startMs: number,
): Clock & { nowMs: number; pending: Array<{ at: number; fn: () => void }> } {
  const state = {
    nowMs: startMs,
    pending: [] as Array<{ at: number; fn: () => void }>,
    now() {
      return state.nowMs;
    },
    schedule(fn: () => void, delayMs: number) {
      state.pending.push({ at: state.nowMs + delayMs, fn });
    },
  };
  return state;
}

/** Fire the earliest due callback, if any. Returns true if one fired. */
function fireDue(clock: {
  nowMs: number;
  pending: Array<{ at: number; fn: () => void }>;
}): boolean {
  clock.pending.sort((a, b) => a.at - b.at);
  const idx = clock.pending.findIndex((cb) => cb.at <= clock.nowMs);
  if (idx === -1) return false;
  const [cb] = clock.pending.splice(idx, 1);
  cb?.fn();
  return true;
}

test('scheduler: the first pulse comes seconds after start when none is recent', () => {
  const hbMs = 3600_000;
  const clock = makeFakeClock(0);
  const fired: PulseWindow[] = [];
  const sched = new Scheduler({
    heartbeatMs: hbMs,
    clock,
    onFire: (w) => fired.push(w),
    getLastWindowEnd: () => null,
    rng: () => 0.5, // no jitter
  });
  sched.start();
  assert.equal(clock.pending.length, 1, 'one tick scheduled after start');
  assert.equal(clock.pending[0]?.at, START_DELAY_MS, 'not a whole heartbeat later');
  clock.nowMs = START_DELAY_MS;
  assert.ok(fireDue(clock), 'tick should fire');
  assert.equal(fired.length, 1);
  assert.equal(clock.pending[0]?.at, START_DELAY_MS + hbMs, 'then every heartbeat');
});

test('scheduler: a restart soon after a pulse waits until that pulse is a heartbeat old', () => {
  const hbMs = 3600_000;
  const t0 = Date.parse('2026-10-05T12:00:00.000Z');
  const clock = makeFakeClock(t0);
  const recent = new Date(t0 - 10 * 60_000).toISOString(); // last pulse 10 min ago
  const sched = new Scheduler({
    heartbeatMs: hbMs,
    clock,
    onFire: () => {},
    getLastWindowEnd: () => recent,
    rng: () => 0.5,
  });
  sched.start();
  assert.equal(clock.pending[0]?.at, t0 + 50 * 60_000, 'due 50 min from now, not at once');
  const old = makeFakeClock(t0);
  new Scheduler({
    heartbeatMs: hbMs,
    clock: old,
    onFire: () => {},
    getLastWindowEnd: () => new Date(t0 - 3 * hbMs).toISOString(),
    rng: () => 0.5,
  }).start();
  assert.equal(old.pending[0]?.at, t0 + START_DELAY_MS, 'overdue → seconds after start');
});

test('6h gap yields one pulse whose window_start covers the gap, not six', () => {
  const hbMs = 3600_000; // 1h
  const T0 = new Date('2024-01-01T06:00:00.000Z').getTime();
  // Last pulse ended 6h before T0
  const lastWindowEnd = new Date(T0 - 6 * hbMs).toISOString();

  const clock = makeFakeClock(T0);
  const fired: PulseWindow[] = [];
  let currentLastWindowEnd: string | null = lastWindowEnd;

  const sched = new Scheduler({
    heartbeatMs: hbMs,
    clock,
    onFire: (w) => {
      fired.push(w);
      currentLastWindowEnd = w.window_end;
    },
    getLastWindowEnd: () => currentLastWindowEnd,
    rng: () => 0.5, // exactly 1h delay, no jitter
  });

  // start() schedules first tick at T0 + 1h
  sched.start();
  assert.equal(clock.pending.length, 1);
  assert.equal(fired.length, 0);

  // Machine was asleep: jump 6h forward
  clock.nowMs = T0 + 6 * hbMs;

  // Fire the ONE pending tick (originally scheduled at T0+1h, now due)
  assert.ok(fireDue(clock), 'tick must fire');

  // Only one pulse — not six
  assert.equal(fired.length, 1, 'exactly one pulse fires for a 6h gap');

  // window_start must cover the full 6h gap
  const w = fired[0];
  assert.ok(w !== undefined);
  assert.equal(w.window_start, lastWindowEnd, 'window_start must be the last pulse window end');
  assert.equal(w.window_end, new Date(T0 + 6 * hbMs).toISOString(), 'window_end must be now');

  // Next tick is scheduled from the CURRENT time, not from T0+1h
  assert.equal(clock.pending.length, 1, 'next tick is scheduled after firing');
  const nextPending = clock.pending[0];
  assert.ok(nextPending !== undefined);
  assert.ok(nextPending.at > T0 + 6 * hbMs, 'next tick is in the future from now');
});

test('two consecutive ticks each build on the previous window_end', () => {
  const hbMs = 600_000; // 10m
  const clock = makeFakeClock(0);
  const fired: PulseWindow[] = [];
  let currentLastWindowEnd: string | null = null;

  const sched = new Scheduler({
    heartbeatMs: hbMs,
    clock,
    onFire: (w) => {
      fired.push(w);
      currentLastWindowEnd = w.window_end;
    },
    getLastWindowEnd: () => currentLastWindowEnd,
    rng: () => 0.5,
  });

  sched.start();

  // tick 1
  clock.nowMs = hbMs;
  fireDue(clock);
  assert.equal(fired.length, 1);
  const w1 = fired[0];
  assert.ok(w1 !== undefined);
  assert.equal(w1.window_start, new Date(hbMs - FIRST_WINDOW_LOOKBACK_MS).toISOString());

  // tick 2
  clock.nowMs = 2 * hbMs;
  fireDue(clock);
  assert.equal(fired.length, 2);
  const w2 = fired[1];
  assert.ok(w2 !== undefined);
  // window_start of tick 2 = window_end of tick 1
  assert.equal(w2.window_start, w1.window_end);
});
