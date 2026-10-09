/**
 * Whether a pulse needs a Claude turn. The
 * collect phase, the gates and the reap still run every pulse; only the turn —
 * the expensive part — is skipped when nothing changed since the last one.
 * Idle PetClinic pulses cost $0.10–0.16 each, about $12/day at a 15-minute
 * heartbeat: past the $5 default ceiling with nothing to do.
 *
 * News, any of:
 *  - a manual Pulse now, or no turn yet;
 *  - no turn for PERIODIC_TURN_MS — the agent still looks around now and then;
 *  - this pulse filed a ticket, or a collector errored;
 *  - since the last turn: a human did something (any event by 'human'), an
 *    escalation was answered, or a child finished or filed a follow-up
 *    (events carrying a session).
 */

import type Database from 'better-sqlite3';
import { parseStoredTime } from './time.ts';

export const PERIODIC_TURN_MS = 2 * 3600 * 1000;

/** Pulses that ran a turn: finished, not gate-skipped, not themselves turn-less. */
const LAST_TURN = `
  SELECT id, ended_at FROM pulses
  WHERE agent_id = ? AND id != ? AND ended_at IS NOT NULL
    AND status IN ('acted', 'clean', 'escalated')
    AND (summary IS NULL OR summary NOT LIKE 'no turn — %')
  ORDER BY id DESC LIMIT 1`;

export type TurnDecision = { turn: true; why: string } | { turn: false; lastTurnPulse: number };

export function turnNeeded(
  db: Database.Database,
  agentId: string,
  pulseId: number,
  opts: { manual?: boolean; now?: number } = {},
): TurnDecision {
  if (opts.manual) return { turn: true, why: 'manual pulse' };
  const last = db.prepare(LAST_TURN).get(agentId, pulseId) as
    | { id: number; ended_at: string }
    | undefined;
  if (!last) return { turn: true, why: 'first turn' };

  const now = opts.now ?? Date.now();
  const endedMs = parseStoredTime(last.ended_at);
  if (now - endedMs >= PERIODIC_TURN_MS) return { turn: true, why: 'periodic turn' };

  const filed = db
    .prepare(
      `SELECT count(*) AS n FROM pulse_findings
       WHERE pulse_id = ? AND ((outcome = 'finding' AND ticket_id IS NOT NULL) OR outcome = 'error')`,
    )
    .get(pulseId) as { n: number };
  if (filed.n > 0) return { turn: true, why: 'new findings this pulse' };

  const since = `julianday(created_at) > julianday(@at)`;
  const human = db
    .prepare(
      `SELECT count(*) AS n FROM ticket_events
       WHERE ${since} AND (actor = 'human' OR (session_id IS NOT NULL AND event IN ('completed','timeout','error','created')))`,
    )
    .get({ at: last.ended_at }) as { n: number };
  if (human.n > 0) return { turn: true, why: 'a human or a child acted' };

  const answered = db
    .prepare(
      `SELECT count(*) AS n FROM escalations
       WHERE agent_id = ? AND answered_at IS NOT NULL AND julianday(answered_at) > julianday(?)`,
    )
    .get(agentId, last.ended_at) as { n: number };
  if (answered.n > 0) return { turn: true, why: 'an escalation was answered' };

  return { turn: false, lastTurnPulse: last.id };
}
