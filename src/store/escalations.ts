import type { Db } from '../db.ts';
import type { Escalation, EscalationSeverity, EscalationVerdict } from '../types.ts';

export type CreateEscalationInput = {
  agentId: string;
  pulseId?: number | null;
  ticketId?: number | null;
  severity: EscalationSeverity;
  question: string;
  context?: string | null;
  options?: string[] | null;
};

/** Raise a question for the human operator. Returns the new row's id. */
export function createEscalation(db: Db, input: CreateEscalationInput): number {
  const result = db
    .prepare(
      `INSERT INTO escalations (agent_id, pulse_id, ticket_id, severity, question, context, options)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agentId,
      input.pulseId ?? null,
      input.ticketId ?? null,
      input.severity,
      input.question,
      input.context ?? null,
      input.options ? JSON.stringify(input.options) : null,
    );
  return Number(result.lastInsertRowid);
}

export function getEscalation(db: Db, id: number): Escalation | undefined {
  return db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Escalation | undefined;
}

/** Unanswered escalations, oldest first. Optionally scoped to one agent. */
export function listUnanswered(db: Db, opts: { agentId?: string } = {}): Escalation[] {
  if (opts.agentId) {
    return db
      .prepare(
        `SELECT * FROM escalations WHERE answered_at IS NULL AND agent_id = ? ORDER BY created_at ASC`,
      )
      .all(opts.agentId) as Escalation[];
  }
  return db
    .prepare(`SELECT * FROM escalations WHERE answered_at IS NULL ORDER BY created_at ASC`)
    .all() as Escalation[];
}

/**
 * Answer an escalation; this unblocks its ticket on the next pulse. Throws if the id doesn't exist or is already
 * answered — answering is a one-time human act, not an update.
 */
export function answerEscalation(
  db: Db,
  id: number,
  answer: string,
  answeredBy: string,
  verdict: EscalationVerdict | null = null,
): void {
  const row = getEscalation(db, id);
  if (!row) throw new Error(`escalation #${id} not found`);
  if (row.answered_at) throw new Error(`escalation #${id} was already answered`);

  db.prepare(
    `UPDATE escalations SET answer = ?, answered_by = ?, verdict = ?, answered_at = datetime('now')
     WHERE id = ?`,
  ).run(answer, answeredBy, verdict, id);
}

/**
 * The oldest unanswered `blocking` escalation tied to a ticket, or undefined.
 * A blocking escalation pauses staffing of its ticket until answered — this
 * applies to every capability tier.
 */
export function getOpenBlockingEscalation(db: Db, ticketId: number): Escalation | undefined {
  return db
    .prepare(
      `SELECT * FROM escalations
       WHERE ticket_id = ? AND severity = 'blocking' AND answered_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(ticketId) as Escalation | undefined;
}

/**
 * Whether a human has approved this ticket. A `release` session always
 * requires a human approval on the escalation queue before it starts: no
 * exceptions, no auto-approval rule.
 *
 * Approval is an explicit `approve` verdict. The most
 * recent verdict on the ticket wins, so a later `reject` revokes an earlier
 * approve; answers without a verdict never count. `answered_at` has one-second
 * resolution, so ties fall back to escalation id.
 */
export function hasApproval(db: Db, ticketId: number): boolean {
  const row = db
    .prepare(
      `SELECT verdict FROM escalations
       WHERE ticket_id = ? AND verdict IS NOT NULL
       ORDER BY answered_at DESC, id DESC LIMIT 1`,
    )
    .get(ticketId) as { verdict: EscalationVerdict } | undefined;
  return row?.verdict === 'approve';
}
