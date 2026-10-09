import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainSkip, projectSpend } from './health.ts';

// ── explainSkip: every gate refusal in plain words, with the fix ──────────────

test('explainSkip: each gate reason gets a plain explanation and a fix', () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ['PAUSED file present', /kill switch/i, /Resume/],
    ["agent state is 'tripped'", /budget/i, /Resume/],
    ["agent state is 'paused'", /not running/i, /Start/],
    ["agent state is 'stopped'", /not running/i, /Start/],
    [
      'daily spend $5.20 meets or exceeds ceiling $5.00',
      /\$5\.20.*\$5\.00/,
      /per_day_usd|UTC midnight/,
    ],
    [
      'daily spend $3.10 + $3.00 reserved meets or exceeds ceiling $5.00',
      /reserved/i,
      /finish|per_day_usd/,
    ],
    ['live children (4) meets or exceeds max_children (4)', /4 child/i, /max_children|finish/],
    ['quiet hours active (22:00–07:00)', /22:00–07:00/, /quiet_hours/],
    ['working tree is dirty', /uncommitted/i, /commit|stash|allow_dirty/],
    ['could not check working tree', /git/i, /workdir|allow_dirty/],
    ['pulse 12 is still running', /#12/, /wait|finish/i],
    [
      'agent config: agent config /x.agent.md: workdir is required',
      /config/i,
      /\.agent\.md|Register/,
    ],
  ];
  for (const [reason, plain, fix] of cases) {
    const e = explainSkip(reason);
    assert.match(e.plain, plain, reason);
    assert.match(e.fix, fix, reason);
  }
  const unknown = explainSkip('something new');
  assert.equal(unknown.plain, 'something new', 'an unknown reason is shown as-is, never hidden');
});

// ── projectSpend: today's burn and when the ceiling would trip ───────────────

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 3, h, m));

test('projectSpend: hourly series sums to the total; trip time from the recent rate', () => {
  const p = projectSpend({
    costs: [
      { at: at(1, 10).toISOString(), usd: 0.5 },
      { at: at(9, 5).toISOString(), usd: 0.4 },
      { at: at(10, 30).toISOString(), usd: 0.6 },
      { at: at(11, 50).toISOString(), usd: 0.5 },
    ],
    ceilingUsd: 5,
    now: at(12),
  });
  assert.equal(p.series.length, 24);
  assert.equal(p.series[9], 0.4);
  assert.ok(Math.abs(p.spentUsd - 2.0) < 1e-9);
  assert.ok(Math.abs(p.series.reduce((a, b) => a + b, 0) - p.spentUsd) < 1e-9);
  // last 3 h (09:00–12:00): $1.50 → $0.50/h; $3.00 left → 6 h → 18:00 UTC
  assert.ok(Math.abs(p.ratePerHour - 0.5) < 1e-9);
  assert.equal(p.tripAt, at(18).toISOString());
});

test('projectSpend: no trip when the rate would not reach the ceiling before UTC midnight, or nothing is burning', () => {
  const slow = projectSpend({
    costs: [{ at: at(11).toISOString(), usd: 0.3 }],
    ceilingUsd: 5,
    now: at(12),
  });
  assert.equal(slow.tripAt, null, '$0.10/h cannot spend $4.70 in 12 h');
  const idle = projectSpend({ costs: [], ceilingUsd: 5, now: at(12) });
  assert.equal(idle.ratePerHour, 0);
  assert.equal(idle.tripAt, null);
  const over = projectSpend({
    costs: [{ at: at(11).toISOString(), usd: 6 }],
    ceilingUsd: 5,
    now: at(12),
  });
  assert.equal(over.tripped, true, 'already at or over the ceiling');
});
