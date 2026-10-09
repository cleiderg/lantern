/**
 * Presentation helpers the CLI and the page share. The page gets
 * the metrics already as rows from `/api/metrics`, so `lantern metrics` and
 * the Overview card cannot word them differently; `ui/js/format.js` mirrors
 * `formatDuration` for the settings form (held equal by format.test.ts).
 */

import type { Mean, Metrics } from './store/metrics.ts';

/** 3600 → "1h", 900 → "15m", 90 → "90s": the largest unit that is exact. */
export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const hours = (x: Mean) => (x.mean === null ? '—' : `${x.mean.toFixed(1)} h`);

export type MetricRow = { label: string; value: string; detail: string | null };

/** The six metrics, as label / value / detail rows. */
export function metricsRows(m: Metrics): MetricRow[] {
  const p = m.pulses;
  const agentNoise = (c: Metrics['precision'][number]) => c.noise - c.noiseByHuman;
  return [
    {
      label: 'Pulses run vs. scheduled',
      value: `${p.run} / ${p.scheduled} (${pct(p.rate)})`,
      detail: [
        p.missed ? `${p.missed} missed` : 'none missed',
        p.downtimeHours >= 0.05 ? `${p.downtimeHours.toFixed(1)} h daemon down` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
    {
      label: 'Findings per pulse',
      value: m.findings.length
        ? m.findings.map((f) => `${f.actionKey} ${f.perPulse.toFixed(2)}`).join(' · ')
        : '—',
      detail: null,
    },
    {
      label: 'Collector precision',
      value: m.precision.length
        ? m.precision
            .map((c) => `${c.collector.replace('collector:', '')} ${pct(c.precision)}`)
            .join(' · ')
        : '—',
      detail: m.precision.length
        ? m.precision
            .map(
              (c) =>
                `${c.collector.replace('collector:', '')}: ${c.filed} filed, ${c.noise} noise${c.noise ? ` (${c.noiseByHuman} by a human, ${agentNoise(c)} by the agent)` : ''}`,
            )
            .join(' · ')
        : 'no collector tickets',
    },
    {
      label: 'Observation → ticket → closed',
      value: `${hours(m.observationToTicketHours)} → ${hours(m.ticketToCloseHours)}`,
      detail: `${m.observationToTicketHours.n} filed · ${m.ticketToCloseHours.n} fixed`,
    },
    {
      label: 'Human touches per closed ticket',
      value: m.humanTouches.mean === null ? '—' : m.humanTouches.mean.toFixed(2),
      detail: `${m.humanTouches.closed} closed: ${m.humanTouches.closedByHuman} by a human, ${m.humanTouches.closedByAgent} by the agent`,
    },
    {
      label: 'Cost per closed ticket',
      value: m.cost.perClosedUsd === null ? '—' : formatUsd(m.cost.perClosedUsd),
      detail: `${formatUsd(m.cost.spendUsd)} spent · ${m.cost.closed} fixed`,
    },
  ];
}

/** The rows as `lantern metrics` and `lantern status` print them. */
export function formatMetrics(m: Metrics): string {
  const rows = metricsRows(m).map(
    (r) => `  ${r.label.padEnd(33)}${r.value}${r.detail ? ` — ${r.detail}` : ''}`,
  );
  return `${[`Last ${m.days} days:`, ...rows].join('\n')}\n`;
}
