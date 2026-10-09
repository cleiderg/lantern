import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, formatMetrics, metricsRows } from './format.ts';
import type { Metrics } from './store/metrics.ts';

test('formatDuration: the largest exact unit; the page copy agrees', async () => {
  const page = (await import(new URL('./ui/js/format.js', import.meta.url).href)) as {
    fmtDuration: (s: number) => string;
  };
  const cases: Array<[number, string]> = [
    [3600, '1h'],
    [7200, '2h'],
    [900, '15m'],
    [5400, '90m'],
    [90, '90s'],
    [30, '30s'],
  ];
  for (const [s, want] of cases) {
    assert.equal(formatDuration(s), want);
    assert.equal(page.fmtDuration(s), want, `page: ${s}`);
  }
});

test('metricsRows: six rows; formatMetrics prints them under the window', () => {
  const m: Metrics = {
    days: 30,
    since: '2026-09-05T00:00:00.000Z',
    pulses: { run: 9, scheduled: 10, missed: 1, rate: 0.9, downtimeHours: 1.5, perAgent: [] },
    findings: [{ actionKey: 'logs.scan', pulses: 9, findings: 3, perPulse: 1 / 3 }],
    precision: [
      { collector: 'collector:logs', filed: 4, noise: 1, noiseByHuman: 1, precision: 0.75 },
    ],
    observationToTicketHours: { mean: 0.25, n: 4 },
    ticketToCloseHours: { mean: null, n: 0 },
    humanTouches: { mean: null, closed: 0, closedByHuman: 0, closedByAgent: 0 },
    cost: { spendUsd: 1.234, closed: 0, perClosedUsd: null },
  };
  const rows = metricsRows(m);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], {
    label: 'Pulses run vs. scheduled',
    value: '9 / 10 (90.0%)',
    detail: '1 missed · 1.5 h daemon down',
  });
  assert.equal(rows[2]?.value, 'logs 75.0%');
  assert.equal(rows[2]?.detail, 'logs: 4 filed, 1 noise (1 by a human, 0 by the agent)');
  assert.equal(rows[3]?.value, '0.3 h → —');
  assert.equal(rows[5]?.detail, '$1.23 spent · 0 fixed');
  const text = formatMetrics(m);
  assert.match(
    text,
    /^Last 30 days:\n {2}Pulses run vs\. scheduled +9 \/ 10 \(90\.0%\) — 1 missed/,
  );
  assert.equal(text.trimEnd().split('\n').length, 7);
});
