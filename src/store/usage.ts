/**
 * Daily spend accounting — the input to gate 2 (the daily budget) and Law 7.
 *
 * `usage_daily` existed from 001_init.sql and was read by two call sites, but
 * nothing ever wrote it. A spend ceiling whose input is pinned
 * at zero is worse than no ceiling: `lantern status` and the digest both report a
 * comfortable margin the whole way down. Every place a cost becomes final now
 * rolls it up here.
 */

import type Database from 'better-sqlite3';
import { getAgent, setAgentState } from '../agent.ts';
import { DEFAULT_DAILY_CEILING_USD } from '../budget.ts';

export type DailyUsage = {
  day: string;
  cost_usd: number;
  pulses: number;
  sessions: number;
};

/**
 * The `usage_daily.day` key, in **UTC**.
 *
 * Decided rather than inherited: both original
 * readers happened to use `toISOString().slice(0, 10)`, so UTC is already what
 * the stored data means. The trade-off is real — west of Greenwich the ceiling
 * resets mid-evening rather than at local midnight — but a host-zone-dependent
 * key changes meaning when the host moves, and that is worse for a ledger.
 * Every reader and the writer share this one function.
 */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Today's full rollup. A day with no activity reads as zeros, not as absent. */
export function getDailyUsage(db: Database.Database, day: string): DailyUsage {
  const row = db.prepare('SELECT * FROM usage_daily WHERE day = ?').get(day) as
    | DailyUsage
    | undefined;
  return row ?? { day, cost_usd: 0, pulses: 0, sessions: 0 };
}

/** Today's spend only — what gate 2 and the digest compare against the ceiling. */
export function getDailySpend(db: Database.Database, day: string): number {
  return getDailyUsage(db, day).cost_usd;
}

/**
 * Add one pulse's or one session's cost to its day. Returns the new totals so
 * callers can act on the post-write state without a second read.
 */
export function recordDailyUsage(
  db: Database.Database,
  opts: { day?: string; costUsd?: number; pulses?: number; sessions?: number },
): DailyUsage {
  const day = opts.day ?? utcDay();
  db.prepare(
    `INSERT INTO usage_daily (day, cost_usd, pulses, sessions) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd,
       pulses   = pulses   + excluded.pulses,
       sessions = sessions + excluded.sessions`,
  ).run(day, opts.costUsd ?? 0, opts.pulses ?? 0, opts.sessions ?? 0);
  return getDailyUsage(db, day);
}

/**
 * Law 7 — breaching the daily budget sets `agents.state = 'tripped'`,
 * which gate 1 then refuses until a human runs `lantern resume`.
 *
 * Only trips an agent that is currently `running`: a `paused` or `stopped`
 * agent has a state the operator chose, and overwriting it would lose that.
 * Returns true only on the transition, so callers can report it once.
 */
export function enforceDailyCeiling(
  db: Database.Database,
  opts: { agentId: string; ceilingUsd?: number; day?: string },
): boolean {
  const ceiling = opts.ceilingUsd ?? DEFAULT_DAILY_CEILING_USD;
  const day = opts.day ?? utcDay();
  const spent = getDailySpend(db, day);
  if (spent < ceiling) return false;

  // Only a running agent is tripped: a paused or stopped state is one the
  // operator chose, and overwriting it would silently discard that choice.
  if (getAgent(db, opts.agentId)?.state !== 'running') return false;

  setAgentState(
    db,
    opts.agentId,
    'tripped',
    `daily budget breached: $${spent.toFixed(4)} of $${ceiling.toFixed(2)} on ${day} — run \`lantern resume\``,
  );
  return true;
}
