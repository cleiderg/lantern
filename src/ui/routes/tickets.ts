/**
 * Tickets and the human queue: `/api/inbox`, `/api/triage`, `/api/tickets`,
 * and their actions.
 */

import {
  inboxAnswer,
  inboxVerdict,
  ticketClose,
  ticketComment,
  ticketPriority,
  ticketReopen,
  triageAccept,
  triageDismiss,
} from '../../actions.ts';
import type { Db } from '../../db.ts';
import { listUnanswered } from '../../store/escalations.ts';
import { getLinks } from '../../store/links.ts';
import { priorArt } from '../../store/prior-art.ts';
import { getTicket, getTicketEvents, listTickets } from '../../store/tickets.ts';
import type { Session, Ticket, TicketStatus } from '../../types.ts';
import { TICKET_STATUSES } from '../../types.ts';
import { evidenceFor } from './evidence.ts';
import {
  type ApiContext,
  type ApiResponse,
  fail,
  fromAction,
  idParam,
  ok,
  paged,
  pageParam,
  text,
} from './kit.ts';
import { withStructured } from './runs.ts';

export function inbox({ db }: ApiContext): ApiResponse {
  return ok(
    listUnanswered(db).map((e) => ({
      ...e,
      options: e.options ? (JSON.parse(e.options) as unknown) : null,
      ticket_title: e.ticket_id ? (getTicket(db, e.ticket_id)?.title ?? null) : null,
    })),
  );
}

export function triage({ db }: ApiContext): ApiResponse {
  return ok(
    listTickets(db, { needs_triage: true, limit: 500 }).map((t) => ({
      ...t,
      evidence: evidenceFor(db, t),
    })),
  );
}

export function tickets({ db, params, query }: ApiContext): ApiResponse {
  if (params.length > 0) {
    const id = idParam(params);
    if (typeof id !== 'number') return id;
    const ticket = getTicket(db, id);
    if (!ticket) return fail(404, `ticket #${id} not found`);
    const rows = db
      .prepare('SELECT * FROM sessions WHERE ticket_id = ? ORDER BY started_at DESC')
      .all(id) as Session[];
    return ok({
      ticket,
      events: getTicketEvents(db, id),
      links: getLinks(db, id),
      sessions: withStructured(db, rows),
      // Similar tickets, read-only: no ctx, so prior_art writes no links from a GET.
      priorArt: priorArt(
        db,
        // Title only, as the ticket search does: a body full of email headers or a
        // stack trace makes the match too strict to find anything.
        { title: ticket.title, fingerprint: ticket.fingerprint },
        { limit: 5, fromTicketId: id },
      ),
    });
  }
  const statusFilter = query.get('status') || undefined;
  if (statusFilter && !(TICKET_STATUSES as readonly string[]).includes(statusFilter)) {
    return fail(400, `unknown status '${statusFilter}'`);
  }
  const search = query.get('search')?.trim();
  const page = pageParam(query);
  if (page !== null && typeof page !== 'number') return page;
  if (page !== null && !search) {
    const status = statusFilter as TicketStatus | undefined;
    return ok(paged(page, (limit, offset) => listTickets(db, { status, limit, offset })));
  }
  let rows: Ticket[];
  if (search) {
    rows = priorArt(db, { title: search }, { limit: 50 })
      .map((h) => getTicket(db, h.id))
      .filter((t): t is Ticket => t !== undefined);
    if (statusFilter) rows = rows.filter((t) => t.status === statusFilter);
  } else {
    rows = listTickets(db, { status: statusFilter as TicketStatus | undefined, limit: 200 });
  }
  // A search is one ranked page of at most 50 (prior-art ranking).
  return ok(page === null ? rows : { rows, page: 1, more: false });
}

export function inboxAction({ db, params, body }: ApiContext): ApiResponse {
  const id = idParam(params);
  if (typeof id !== 'number') return id;
  const t = text(body, 'text');
  if (typeof t !== 'string') return t;
  switch (params[1]) {
    case 'answer':
      return fromAction(inboxAnswer(db, id, t));
    case 'approve':
      return fromAction(inboxVerdict(db, id, 'approve', t));
    case 'reject':
      return fromAction(inboxVerdict(db, id, 'reject', t));
    default:
      return fail(404, 'not found');
  }
}

const BULK_MAX = 500;

/**
 * `triage/bulk`: one request, many tickets, each through the same action
 * the single buttons and the CLI use. Validates the whole request first; then
 * reports which tickets could not be done instead of failing the batch.
 */
function triageBulk(db: Db, body: Record<string, unknown>): ApiResponse {
  const { action, ids } = body;
  if (action !== 'accept' && action !== 'dismiss')
    return fail(400, "action must be 'accept' or 'dismiss'");
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > BULK_MAX ||
    !ids.every((n) => Number.isInteger(n) && n > 0)
  ) {
    return fail(400, `ids must be 1–${BULK_MAX} ticket ids`);
  }
  const reason = text(body, 'reason');
  if (typeof reason !== 'string') return reason;
  if (action === 'dismiss' && !reason.trim()) return fail(400, 'a reason is required to dismiss');
  const failed: Array<{ id: number; error: string }> = [];
  for (const id of ids as number[]) {
    const r = action === 'accept' ? triageAccept(db, id) : triageDismiss(db, id, reason);
    if (!r.ok) failed.push({ id, error: r.error });
  }
  const done = ids.length - failed.length;
  return ok({
    done,
    failed,
    messages: [
      `${done} ticket(s) ${action === 'accept' ? 'accepted' : 'dismissed as wontfix'}${failed.length ? `, ${failed.length} failed` : ''}`,
    ],
  });
}

export function triageAction({ db, params, body }: ApiContext): ApiResponse {
  if (params[0] === 'bulk' && params.length === 1) return triageBulk(db, body);
  const id = idParam(params);
  if (typeof id !== 'number') return id;
  if (params[1] === 'accept') return fromAction(triageAccept(db, id));
  if (params[1] === 'dismiss') {
    const reason = text(body, 'reason');
    return typeof reason === 'string' ? fromAction(triageDismiss(db, id, reason)) : reason;
  }
  return fail(404, 'not found');
}

/** `tickets/:id/{comment,priority,close,reopen}` — the human's actions on one ticket. */
export function ticketAction({ db, params, body }: ApiContext): ApiResponse {
  const id = idParam(params);
  if (typeof id !== 'number') return id;
  const field = (key: string) => text(body, key);
  switch (params[1]) {
    case 'comment': {
      const b = field('body');
      return typeof b === 'string' ? fromAction(ticketComment(db, id, b)) : b;
    }
    case 'priority': {
      const p = field('priority');
      return typeof p === 'string' ? fromAction(ticketPriority(db, id, p)) : p;
    }
    case 'close': {
      const st = field('status');
      const r = field('resolution');
      if (typeof st !== 'string') return st;
      return typeof r === 'string' ? fromAction(ticketClose(db, id, st, r)) : r;
    }
    case 'reopen': {
      const r = field('reason');
      return typeof r === 'string' ? fromAction(ticketReopen(db, id, r)) : r;
    }
    default:
      return fail(404, 'not found');
  }
}
