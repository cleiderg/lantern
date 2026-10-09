/**
 * What may be done to a ticket, and by whom. One module for the
 * agent's MCP tools (mcp/tools-*.ts) and the human's actions (actions.ts):
 * the split let the two paths drift — a human's wontfix stopped suppressing
 * its fingerprint, the agent could re-close a closed ticket and a human could not, and
 * only the prompt kept the agent from accepting its own tickets.
 *
 * Each check returns null when allowed, or the refusal to show. Wording is
 * load-bearing: "not found", "already" and "does not need" map to 404/409 in
 * the UI's API (fromAction), and tests match on it.
 */

import type { Db } from './db.ts';
import { getOpenBlockingEscalation, hasApproval } from './store/escalations.ts';
import { closeTicket, getTicket, updateTicket } from './store/tickets.ts';
import {
  type EventContext,
  isTerminalTicket,
  LIVE_SQL,
  TERMINAL_TICKET_STATUSES,
  type TerminalTicketStatus,
  type Ticket,
} from './types.ts';

export type Actor = 'agent' | 'human';
export type Refusal = string | null;

const terminalList = TERMINAL_TICKET_STATUSES.join(', ').replace(/, (?=[^,]*$)/, ' or ');

/**
 * An update (status, priority, title, body, needs_triage). A terminal status
 * goes through closeAs, which requires a resolution; accepting a ticket —
 * clearing needs_triage — is a human act.
 */
export function checkUpdate(
  actor: Actor,
  ticket: Ticket | undefined,
  patch: { status?: string; needs_triage?: boolean; [field: string]: unknown },
): Refusal {
  if (!ticket) return 'ticket not found';
  if (patch.status !== undefined && isTerminalTicket(patch.status)) {
    return `cannot set status '${patch.status}' by an update — use tickets_close (or Close), which requires a resolution`;
  }
  if (actor === 'agent' && patch.needs_triage === false) {
    return 'cannot clear needs_triage — only a human accepts a ticket (lantern triage accept, or the UI). Leave it for triage, or escalate if it is urgent.';
  }
  return null;
}

/**
 * Close, wontfix or duplicate — the same rules for both: a terminal status, a
 * resolution, and not already closed (reopen first). closeTicket writes the
 * event and suppresses the fingerprint on wontfix.
 */
export function closeAs(
  db: Db,
  _actor: Actor,
  id: number,
  status: TerminalTicketStatus,
  resolution: string,
  ctx: EventContext & { closed_pulse?: number | null },
): Refusal {
  const ticket = getTicket(db, id);
  if (!ticket) return `#${id} not found`;
  if (!isTerminalTicket(status)) return `status must be ${terminalList}`;
  if (isTerminalTicket(ticket.status))
    return `#${id} is already ${ticket.status} — reopen it first`;
  const { closed_pulse, ...eventCtx } = ctx;
  try {
    closeTicket(db, id, { status, resolution, closed_pulse: closed_pulse ?? null }, eventCtx);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

/** A human accepts a ticket out of triage: it may now be staffed. */
export function acceptTicket(db: Db, id: number): Refusal {
  const ticket = getTicket(db, id);
  if (!ticket) return `#${id} not found`;
  if (!ticket.needs_triage) return `#${id} does not need triage`;
  updateTicket(db, id, { needs_triage: false }, { actor: 'human' });
  return null;
}

/** Whether `agentId` may staff `ticket` at `tier` now. */
export function staffRefusal(
  db: Db,
  ticket: Ticket | undefined,
  agentId: string,
  tier: string,
): Refusal {
  if (!ticket) return 'Ticket not found';
  const id = ticket.id;
  if (ticket.agent_id && ticket.agent_id !== agentId) {
    return `Ticket #${id} belongs to agent '${ticket.agent_id}' — only its own agent staffs it`;
  }
  if (isTerminalTicket(ticket.status))
    return `Ticket #${id} is ${ticket.status} — reopen it before staffing`;
  // A ticket awaiting triage is not staffed until a human accepts it.
  if (ticket.needs_triage) {
    return `Ticket #${id} is awaiting triage — a human accepts it first (lantern triage accept, or the UI)`;
  }
  const live = db
    .prepare(`SELECT id FROM sessions WHERE ticket_id = ? AND status IN ${LIVE_SQL} LIMIT 1`)
    .get(id) as { id: string } | undefined;
  if (live) return `Ticket #${id} already has a live session (${live.id})`;
  // A blocking escalation on this ticket pauses staffing at any tier.
  const blocking = getOpenBlockingEscalation(db, id);
  if (blocking) {
    return (
      `blocked_by_escalation: ticket #${id} has an unanswered blocking escalation ` +
      `(#${blocking.id}: ${blocking.question}) — resolve it with \`lantern inbox answer ${blocking.id} <text>\` first`
    );
  }
  // A release always requires a human approval — an explicit approve verdict.
  if (tier === 'release' && !hasApproval(db, id)) {
    return (
      `release_requires_approval: ticket #${id} needs a human approve verdict ` +
      `(\`lantern inbox approve <id>\`) before a release-tier session can be staffed — call escalate() first`
    );
  }
  return null;
}
