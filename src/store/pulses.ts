import type Database from 'better-sqlite3';
import { setAgentLastPulse } from '../agent.ts';
import { PER_SESSION_CEILING_USD } from '../budget.ts';
import { enforceDailyCeiling, recordDailyUsage, utcDay } from './usage.ts';

export { getDailySpend } from './usage.ts';

import type { Pulse, PulseFinding, PulseFindingOutcome, PulseStatus } from '../types.ts';

/**
 * `agents.last_pulse_at` is stamped by both pulse creators below rather than by
 * each caller. It used to be written only by the daemon (`src/daemon.ts`), so
 * `lantern pulse --now` left it null — `lantern status` reported `last_pulse=never`
 * after two real pulses, and the dead-man alert (no pulse in 3×
 * heartbeat) reads that same field. Every path that records a pulse now stamps
 * it, so none can forget.
 *
 * `next_pulse_at` is deliberately NOT set here: only the daemon's scheduler
 * knows when the next tick is due, and a manual pulse must not advertise a
 * schedule that nothing will honour.
 */
export function createSkippedPulse(
  db: Database.Database,
  opts: { agentId: string; windowStart: string; windowEnd: string; reason: string },
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO pulses (agent_id, started_at, ended_at, window_start, window_end, status, error)
       VALUES (?, ?, ?, ?, ?, 'skipped', ?)`,
    )
    .run(opts.agentId, now, now, opts.windowStart, opts.windowEnd, opts.reason);
  // A gated pulse still proves the loop is alive, which is what the
  // dead-man alert measures — so it stamps the agent like any other pulse.
  setAgentLastPulse(db, opts.agentId, now);
  return result.lastInsertRowid as number;
}

export function createRunningPulse(
  db: Database.Database,
  opts: { agentId: string; windowStart: string; windowEnd: string },
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO pulses (agent_id, started_at, window_start, window_end, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .run(opts.agentId, now, opts.windowStart, opts.windowEnd);
  setAgentLastPulse(db, opts.agentId, now);
  return result.lastInsertRowid as number;
}

/**
 * Close a pulse row and roll its cost into `usage_daily`.
 *
 * The rollup lives here because this is the one choke point every pulse close
 * passes through — cost recorded on the `pulses` row but not aggregated is what
 * left the spend ceiling permanently disarmed. Breaching the
 * ceiling trips the agent per Law 7; `day` and `dailyCeilingUsd` are
 * injectable so tests need not depend on the wall clock or the default.
 */
export function finishPulse(
  db: Database.Database,
  id: number,
  opts: {
    status: PulseStatus;
    summary?: string;
    costUsd?: number;
    durationMs?: number;
    sessionId?: string;
    error?: string;
    day?: string;
    dailyCeilingUsd?: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pulses SET
         ended_at = ?, status = ?, summary = ?, cost_usd = ?,
         duration_ms = ?, session_id = ?, error = ?
       WHERE id = ?`,
  ).run(
    now,
    opts.status,
    opts.summary ?? null,
    opts.costUsd ?? 0,
    opts.durationMs ?? null,
    opts.sessionId ?? null,
    opts.error ?? null,
    id,
  );

  const day = opts.day ?? utcDay();
  recordDailyUsage(db, { day, costUsd: opts.costUsd ?? 0, pulses: 1 });

  const row = db.prepare('SELECT agent_id FROM pulses WHERE id = ?').get(id) as
    | { agent_id: string }
    | undefined;
  if (row) {
    enforceDailyCeiling(db, {
      agentId: row.agent_id,
      ceilingUsd: opts.dailyCeilingUsd,
      day,
    });
  }
}

export function getRunningPulse(db: Database.Database, agentId: string): Pulse | null {
  return (
    (db
      .prepare(`SELECT * FROM pulses WHERE agent_id = ? AND status = 'running' LIMIT 1`)
      .get(agentId) as Pulse | undefined) ?? null
  );
}

/**
 * Children that have actually started (`running`/`waiting`). A `starting` row
 * is a queue entry: counting it let a queue of 20 hold gate 3 shut, and since
 * reap only runs after a pulse, the queue never drained.
 */
export function getLiveChildrenCount(db: Database.Database, agentId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) as cnt FROM sessions
       WHERE agent_id = ? AND status IN ('running','waiting')`,
    )
    .get(agentId) as { cnt: number };
  return row.cnt;
}

/**
 * Sum of the cost ceilings for all started (running/waiting) sessions. Each
 * has a $perSessionCeilingUsd reservation against the daily budget, taken at
 * spawn — a queued session spends nothing and reserves nothing.
 */
export function getReservedBudget(
  db: Database.Database,
  agentId: string,
  perSessionCeilingUsd = PER_SESSION_CEILING_USD,
): number {
  return getLiveChildrenCount(db, agentId) * perSessionCeilingUsd;
}

export function writePulseFinding(
  db: Database.Database,
  opts: {
    pulseId: number;
    actionKey: string;
    outcome: PulseFindingOutcome;
    detail?: string;
    ticketId?: number;
  },
): void {
  db.prepare(
    `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail, ticket_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.pulseId, opts.actionKey, opts.outcome, opts.detail ?? null, opts.ticketId ?? null);
}

export function getPulseFindings(db: Database.Database, pulseId: number): PulseFinding[] {
  return db
    .prepare(`SELECT * FROM pulse_findings WHERE pulse_id = ? ORDER BY id`)
    .all(pulseId) as PulseFinding[];
}

export function getRecentPulses(db: Database.Database, agentId: string, limitHours = 24): Pulse[] {
  return db
    .prepare(
      `SELECT * FROM pulses
       WHERE agent_id = ? AND started_at >= datetime('now', ?)
       ORDER BY started_at DESC`,
    )
    .all(agentId, `-${limitHours} hours`) as Pulse[];
}

/** Mark every 'running' pulse for this agent as 'error' and write a finding.
 *  Called on daemon startup to clean up from a previous crash. Returns count recovered. */
export function recoverOrphanedPulses(db: Database.Database, agentId: string): number {
  const now = new Date().toISOString();
  const errorMsg = 'daemon restarted: orphaned pulse recovered';

  return db.transaction(() => {
    const running = db
      .prepare(`SELECT id FROM pulses WHERE agent_id = ? AND status = 'running'`)
      .all(agentId) as { id: number }[];

    if (running.length === 0) return 0;

    db.prepare(
      `UPDATE pulses SET status = 'error', ended_at = ?, error = ?
       WHERE agent_id = ? AND status = 'running'`,
    ).run(now, errorMsg, agentId);

    const insertFinding = db.prepare(
      `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail)
       VALUES (?, 'heartbeat.selfcheck', 'error', ?)`,
    );
    for (const { id } of running) {
      insertFinding.run(id, errorMsg);
    }

    return running.length;
  })();
}
