/**
 * The metrics that say whether Lantern is working, computed from
 * the store over a window, never stored. Timestamps go through julianday(),
 * which reads both stored formats (ISO with Z and SQLite's zoneless UTC).
 *
 * Definitions:
 * - pulses run vs. scheduled: per agent, the heartbeat slots between its
 *   consecutive pulses. A gap longer than DOWNTIME_HEARTBEATS heartbeats is the
 *   daemon being down — downtime, not missed pulses.
 * - findings per pulse: pulse_findings with outcome 'finding', per action key,
 *   over the pulses in the window.
 * - precision: (filed − wontfix) / filed, for collector tickets filed in
 *   the window.
 * - observation → ticket: an observation's first_seen to the created_at of
 *   the ticket with its fingerprint (the collectors link them by fingerprint;
 *   observations.ticket_id is not filled in); ticket → close: created_at to closed_at, for tickets closed as
 *   fixed ('closed') in the window.
 * - human touches: ticket_events by 'human' on tickets closed in the window,
 *   any close status — a dismissal costs a touch too.
 * - cost per closed ticket: usage_daily spend in the window over tickets
 *   closed as fixed in the window.
 */

import type Database from 'better-sqlite3';
import { TERMINAL_SQL } from '../types.ts';

const DOWNTIME_HEARTBEATS = 6;

export type Mean = { mean: number | null; n: number };

/**
 * The agent closes most tickets itself (duplicates, its own
 * wontfix calls), so "0 human touches" and "50% precision" read as a verdict
 * nobody gave. Who wrote the latest close of ticket `t`:
 */
const CLOSED_BY_HUMAN = `coalesce((SELECT e.actor = 'human' FROM ticket_events e
  WHERE e.ticket_id = t.id AND e.event = 'closed' ORDER BY e.id DESC LIMIT 1), 0)`;

export type Metrics = {
  days: number;
  since: string;
  pulses: {
    run: number;
    scheduled: number;
    missed: number;
    /** run / scheduled; null with no pulses. */
    rate: number | null;
    downtimeHours: number;
    perAgent: Array<{ agentId: string; run: number; scheduled: number; downtimeHours: number }>;
  };
  findings: Array<{ actionKey: string; pulses: number; findings: number; perPulse: number }>;
  /** noiseByHuman: wontfix closes a human made — the rest the agent decided itself. */
  precision: Array<{
    collector: string;
    filed: number;
    noise: number;
    noiseByHuman: number;
    precision: number;
  }>;
  observationToTicketHours: Mean;
  ticketToCloseHours: Mean;
  humanTouches: {
    mean: number | null;
    closed: number;
    closedByHuman: number;
    closedByAgent: number;
  };
  cost: { spendUsd: number; closed: number; perClosedUsd: number | null };
};

const mean = (xs: number[]): Mean => ({
  mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
  n: xs.length,
});

export function computeMetrics(
  db: Database.Database,
  opts: { days?: number; now?: Date } = {},
): Metrics {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const inWindow = (col: string) =>
    `julianday(${col}) >= julianday(@since) AND julianday(${col}) <= julianday(@now)`;
  const p = { since, now: now.toISOString() };

  // ── pulses run vs. scheduled ────────────────────────────────────────────────
  const agents = db.prepare('SELECT id, heartbeat_seconds AS hb FROM agents').all() as {
    id: string;
    hb: number;
  }[];
  const perAgent = agents.map((a) => {
    const starts = (
      db
        .prepare(
          `SELECT julianday(started_at) * 86400 AS t FROM pulses
           WHERE agent_id = @agent AND ${inWindow('started_at')} ORDER BY t`,
        )
        .all({ ...p, agent: a.id }) as { t: number }[]
    ).map((r) => r.t);
    let scheduled = starts.length ? 1 : 0;
    let downtime = 0;
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] as number) - (starts[i - 1] as number);
      if (gap > DOWNTIME_HEARTBEATS * a.hb) {
        downtime += gap;
        scheduled += 1;
      } else {
        scheduled += Math.max(1, Math.round(gap / a.hb));
      }
    }
    return { agentId: a.id, run: starts.length, scheduled, downtimeHours: downtime / 3600 };
  });
  const run = perAgent.reduce((n, a) => n + a.run, 0);
  const scheduled = perAgent.reduce((n, a) => n + a.scheduled, 0);

  // ── findings per pulse, by action ───────────────────────────────────────────
  const pulsesInWindow = (
    db.prepare(`SELECT count(*) AS n FROM pulses WHERE ${inWindow('started_at')}`).get(p) as {
      n: number;
    }
  ).n;
  const findings = (
    db
      .prepare(
        `SELECT f.action_key AS actionKey, count(DISTINCT f.pulse_id) AS pulses,
                sum(f.outcome = 'finding') AS findings
         FROM pulse_findings f JOIN pulses q ON q.id = f.pulse_id
         WHERE ${inWindow('q.started_at')}
         GROUP BY f.action_key ORDER BY f.action_key`,
      )
      .all(p) as { actionKey: string; pulses: number; findings: number }[]
  ).map((r) => ({ ...r, perPulse: pulsesInWindow ? r.findings / pulsesInWindow : 0 }));

  // ── precision per collector, tickets filed in the window ────────────────────
  const precision = (
    db
      .prepare(
        `SELECT t.origin AS collector, count(*) AS filed, sum(t.status = 'wontfix') AS noise,
                sum(t.status = 'wontfix' AND ${CLOSED_BY_HUMAN}) AS noiseByHuman
         FROM tickets t WHERE t.origin LIKE 'collector:%' AND ${inWindow('t.created_at')}
         GROUP BY t.origin ORDER BY t.origin`,
      )
      .all(p) as { collector: string; filed: number; noise: number; noiseByHuman: number }[]
  ).map((r) => ({ ...r, precision: r.filed ? (r.filed - r.noise) / r.filed : 1 }));

  // ── observation → ticket → close ────────────────────────────────────────────
  const obsToTicket = (
    db
      .prepare(
        `SELECT (julianday(t.created_at) - julianday(o.first_seen)) * 24 AS h
         FROM tickets t JOIN observations o ON o.fingerprint = t.fingerprint
         WHERE ${inWindow('t.created_at')}`,
      )
      .all(p) as { h: number }[]
  ).map((r) => Math.max(0, r.h));
  const fixed = db
    .prepare(
      `SELECT id, (julianday(closed_at) - julianday(created_at)) * 24 AS h
       FROM tickets WHERE status = 'closed' AND closed_at IS NOT NULL AND ${inWindow('closed_at')}`,
    )
    .all(p) as { id: number; h: number }[];

  // ── human touches per closed ticket ─────────────────────────────────────────
  const touches = db
    .prepare(
      `SELECT t.id, (SELECT count(*) FROM ticket_events e WHERE e.ticket_id = t.id AND e.actor = 'human') AS n,
              ${CLOSED_BY_HUMAN} AS byHuman
       FROM tickets t
       WHERE t.status IN ${TERMINAL_SQL} AND t.closed_at IS NOT NULL
         AND ${inWindow('t.closed_at')}`,
    )
    .all(p) as { n: number; byHuman: number }[];

  // ── cost per closed ticket ──────────────────────────────────────────────────
  const spendUsd = (
    db
      .prepare(
        `SELECT coalesce(sum(cost_usd), 0) AS usd FROM usage_daily
         WHERE day >= substr(@since, 1, 10) AND day <= substr(@now, 1, 10)`,
      )
      .get(p) as { usd: number }
  ).usd;

  return {
    days,
    since,
    pulses: {
      run,
      scheduled,
      missed: scheduled - run,
      rate: scheduled ? run / scheduled : null,
      downtimeHours: perAgent.reduce((n, a) => n + a.downtimeHours, 0),
      perAgent,
    },
    findings,
    precision,
    observationToTicketHours: mean(obsToTicket),
    ticketToCloseHours: mean(fixed.map((r) => Math.max(0, r.h))),
    humanTouches: {
      mean: touches.length ? touches.reduce((a, r) => a + r.n, 0) / touches.length : null,
      closed: touches.length,
      closedByHuman: touches.filter((t) => t.byHuman).length,
      closedByAgent: touches.filter((t) => !t.byHuman).length,
    },
    cost: {
      spendUsd,
      closed: fixed.length,
      perClosedUsd: fixed.length ? spendUsd / fixed.length : null,
    },
  };
}
