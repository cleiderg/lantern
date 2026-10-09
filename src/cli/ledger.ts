/**
 * The ledger and the human queue: `tickets`, `ticket`, `triage`, `inbox`.
 * Split out of cli.ts's one `run()` function.
 */

import { inboxAnswer, inboxVerdict, triageAccept, triageDismiss } from '../actions.ts';
import { openDb } from '../db.ts';
import { listUnanswered } from '../store/escalations.ts';
import { getLinks } from '../store/links.ts';
import { priorArt } from '../store/prior-art.ts';
import { getTicket, getTicketEvents, listTickets } from '../store/tickets.ts';
import { formatAge } from '../time.ts';
import type { Ticket, TicketEvent, TicketLink, TicketStatus } from '../types.ts';

import { type CliCtx, report, requireDb } from './shared.ts';

function fmtRow(t: Ticket): string {
  const st = `[${t.status}]`.padEnd(12);
  return `  #${t.id}  ${t.kind.padEnd(13)}  ${st}  ${t.priority}  ${t.title}  (${formatAge(t.created_at)})`;
}

function fmtDetail(ticket: Ticket, events: TicketEvent[], links: TicketLink[]): string {
  const lines: string[] = [];
  const needs = ticket.needs_triage ? '  ⚑ needs_triage' : '';
  lines.push(
    `#${ticket.id}  ${ticket.kind}  [${ticket.status}]  ${ticket.priority}  origin=${ticket.origin}${needs}`,
  );
  lines.push(ticket.title);
  lines.push('');
  lines.push(ticket.body);
  if (ticket.resolution) {
    lines.push('');
    lines.push(`Resolution: ${ticket.resolution}`);
  }
  lines.push('');
  lines.push(`── Events ${'─'.repeat(60)}`);
  if (events.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of events) {
      const ts = e.created_at.slice(0, 16);
      const payload = e.payload ? `  ${e.payload}` : '';
      lines.push(`  ${ts}  ${e.actor.padEnd(12)}  ${e.event}${payload}`);
    }
  }
  lines.push('');
  lines.push(`── Links ${'─'.repeat(61)}`);
  if (links.length === 0) {
    lines.push('  (none)');
  } else {
    for (const l of links) {
      const note = l.note ? `  ${l.note}` : '';
      lines.push(`  #${l.from_ticket} →[${l.rel}]→ #${l.to_ticket}${note}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function cmdTickets(c: CliCtx): number {
  const { argv, out } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;

  let status: TicketStatus | undefined;
  let search: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) {
      status = argv[i + 1] as TicketStatus;
      i++;
    } else if (argv[i] === '--search' && argv[i + 1]) {
      search = argv[i + 1];
      i++;
    }
  }

  const db = openDb(dbPath);
  try {
    let tickets: Ticket[];
    if (search) {
      const hits = priorArt(db, { title: search }, { limit: 20 });
      tickets = hits.map((h) => getTicket(db, h.id)).filter((t): t is Ticket => t !== undefined);
      if (status) tickets = tickets.filter((t) => t.status === status);
    } else {
      tickets = listTickets(db, { status, limit: 100 });
    }

    if (tickets.length === 0) {
      out.write('no tickets\n');
    } else {
      const label = search
        ? `${tickets.length} match(es) for "${search}"`
        : `${tickets.length} ticket(s)`;
      out.write(`${label}:\n`);
      for (const t of tickets) {
        out.write(`${fmtRow(t)}\n`);
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

export function cmdTicket(c: CliCtx): number {
  const { argv, out, err } = c;
  const rawId = argv[1];
  if (!rawId) {
    err.write('lantern ticket: usage: lantern ticket <id>\n');
    return 1;
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    err.write(`lantern ticket: invalid id '${rawId}'\n`);
    return 1;
  }
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    const ticket = getTicket(db, id);
    if (!ticket) {
      err.write(`lantern ticket: #${id} not found\n`);
      return 1;
    }
    const events = getTicketEvents(db, id);
    const links = getLinks(db, id);
    out.write(fmtDetail(ticket, events, links));
  } finally {
    db.close();
  }
  return 0;
}

export function cmdTriage(c: CliCtx): number {
  const { argv, out, err } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    if (argv[1] === 'accept') {
      const rawId = argv[2];
      if (!rawId) {
        err.write('lantern triage: usage: lantern triage accept <id>\n');
        return 1;
      }
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        err.write(`lantern triage: invalid id '${rawId}'\n`);
        return 1;
      }
      return report(triageAccept(db, id), out, err, 'triage');
    }

    if (argv[1] === 'dismiss') {
      const rawId = argv[2];
      const reason = argv.slice(3).join(' ');
      if (!rawId || !reason) {
        err.write('lantern triage: usage: lantern triage dismiss <id> <reason>\n');
        return 1;
      }
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        err.write(`lantern triage: invalid id '${rawId}'\n`);
        return 1;
      }
      return report(triageDismiss(db, id, reason), out, err, 'triage');
    }

    const tickets = listTickets(db, { needs_triage: true, limit: 100 });
    if (tickets.length === 0) {
      out.write('no tickets need triage\n');
    } else {
      out.write(`${tickets.length} ticket(s) need triage:\n`);
      const groups = new Map<string, Ticket[]>();
      for (const t of tickets) {
        const group = groups.get(t.origin);
        if (group) group.push(t);
        else groups.set(t.origin, [t]);
      }
      for (const [origin, group] of groups) {
        out.write(`\n${origin} (${group.length}):\n`);
        for (const t of group) {
          out.write(`${fmtRow(t)}\n`);
        }
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

export function cmdInbox(c: CliCtx): number {
  const { argv, out, err } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    // approve/reject record a verdict — the only thing that approves a
    // release. `answer` stays a plain reply with no verdict.
    if (argv[1] === 'approve' || argv[1] === 'reject') {
      const verdict = argv[1];
      const rawId = argv[2];
      const text = argv.slice(3).join(' ');
      if (!rawId || (verdict === 'reject' && !text)) {
        err.write(
          verdict === 'approve'
            ? 'lantern inbox: usage: lantern inbox approve <id> [text]\n'
            : 'lantern inbox: usage: lantern inbox reject <id> <reason>\n',
        );
        return 1;
      }
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        err.write(`lantern inbox: invalid id '${rawId}'\n`);
        return 1;
      }
      return report(inboxVerdict(db, id, verdict, text), out, err, 'inbox');
    }

    if (argv[1] === 'answer') {
      const rawId = argv[2];
      const text = argv.slice(3).join(' ');
      if (!rawId || !text) {
        err.write('lantern inbox: usage: lantern inbox answer <id> <text>\n');
        return 1;
      }
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        err.write(`lantern inbox: invalid id '${rawId}'\n`);
        return 1;
      }
      return report(inboxAnswer(db, id, text), out, err, 'inbox');
    }

    const escalations = listUnanswered(db);
    if (escalations.length === 0) {
      out.write('no unanswered escalations\n');
    } else {
      out.write(`${escalations.length} unanswered escalation(s):\n`);
      for (const e of escalations) {
        const ticket = e.ticket_id ? `  ticket=#${e.ticket_id}` : '';
        out.write(
          `  #${e.id}  [${e.severity}]${ticket}  ${e.question}  (${formatAge(e.created_at)})\n`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
