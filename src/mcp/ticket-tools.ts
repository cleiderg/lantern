/**
 * The ticket tools every tier may call (9): tickets_search/get/create/update/
 * comment/link/close, prior_art, escalate. The rules a mutation must pass are
 * ticket-policy's, shared with the human actions.
 */

import { createEscalation } from '../store/escalations.ts';
import { writeEvent } from '../store/events.ts';
import { createLink, getLinks } from '../store/links.ts';
import { buildFtsQuery, priorArt } from '../store/prior-art.ts';
import {
  createTicket,
  getTicket,
  getTicketEvents,
  listTickets,
  setTicketFiles,
  updateTicket,
} from '../store/tickets.ts';
import { checkUpdate, closeAs } from '../ticket-policy.ts';
import { formatAge } from '../time.ts';
import type {
  EscalationSeverity,
  LinkRel,
  TicketKind,
  TicketOrigin,
  TicketPriority,
  TicketStatus,
} from '../types.ts';
import { TERMINAL_TICKET_STATUSES, type TerminalTicketStatus, TICKET_STATUSES } from '../types.ts';
import { fail, ok, type ToolDef } from './tool-kit.ts';

const handleTicketsSearch: ToolDef['handler'] = (db, _ctx, _eventCtx, args) => {
  const query = args.query as string | undefined;
  const status = args.status as TicketStatus | undefined;
  const needsTriage = args.needs_triage as boolean | undefined;
  const limit = (args.limit as number | undefined) ?? 20;

  type Row = {
    id: number;
    title: string;
    status: TicketStatus;
    priority: TicketPriority;
    created_at: string;
  };
  let rows: Row[];

  if (query) {
    // The shared builder (prior-art.ts): it splits on punctuation, as FTS does (c0045cc).
    const q = buildFtsQuery(query);
    if (!q) return ok('[]');
    try {
      const conditions: string[] = [];
      const params: unknown[] = [q];
      if (status) {
        conditions.push('t.status = ?');
        params.push(status);
      }
      if (needsTriage !== undefined) {
        conditions.push('t.needs_triage = ?');
        params.push(needsTriage ? 1 : 0);
      }
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      params.push(limit);
      rows = db
        .prepare(
          `SELECT t.id, t.title, t.status, t.priority, t.created_at
           FROM tickets_fts
           JOIN tickets t ON tickets_fts.rowid = t.id
           WHERE tickets_fts MATCH ? ${where}
           ORDER BY bm25(tickets_fts)
           LIMIT ?`,
        )
        .all(...params) as Row[];
    } catch {
      return fail('Invalid FTS query');
    }
  } else {
    rows = listTickets(db, { status, needs_triage: needsTriage, limit }).map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      created_at: ticket.created_at,
    }));
  }

  return ok(
    JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        priority: r.priority,
        age: formatAge(r.created_at),
      })),
      null,
      2,
    ),
  );
};

const handleTicketsGet: ToolDef['handler'] = (db, _ctx, _eventCtx, args) => {
  const id = args.id as number;
  const ticket = getTicket(db, id);
  if (!ticket) return fail(`Ticket #${id} not found`);
  const events = getTicketEvents(db, id);
  const links = getLinks(db, id);
  return ok(JSON.stringify({ ticket, events, links }, null, 2));
};

const handleTicketsCreate: ToolDef['handler'] = (db, ctx, eventCtx, args) => {
  const kind = args.kind as TicketKind;
  const title = args.title as string;
  const body = args.body as string;
  const origin = args.origin as TicketOrigin;
  const priority = args.priority as TicketPriority | undefined;
  const needsTriage = args.needs_triage as boolean | undefined;
  const fingerprint = args.fingerprint as string | undefined;
  const originRef = args.origin_ref as string | undefined;
  const files = args.files as string[] | undefined;

  const id = createTicket(
    db,
    {
      kind,
      title,
      body,
      origin,
      priority,
      needs_triage: needsTriage,
      fingerprint: fingerprint ?? null,
      origin_ref: originRef ?? null,
      agent_id: ctx.agentId,
      opened_pulse: ctx.pulseId,
    },
    eventCtx,
  );

  if (files && files.length > 0) setTicketFiles(db, id, files);

  // Auto prior-art: links are only written by orchestrator.
  const priors = priorArt(
    db,
    { title, body, files, fingerprint: fingerprint ?? null },
    {
      fromTicketId: id,
      ctx: ctx.tier === 'orchestrator' ? eventCtx : undefined,
    },
  );

  return ok(JSON.stringify({ id, prior_art: priors }, null, 2));
};

const handleTicketsUpdate: ToolDef['handler'] = (db, _ctx, eventCtx, args) => {
  const id = args.id as number;
  // Policy: no terminal status by update; only a human accepts.
  const refusal = checkUpdate('agent', getTicket(db, id), args);
  if (refusal) return fail(refusal.replace('ticket not found', `Ticket #${id} not found`));
  updateTicket(
    db,
    id,
    {
      status: args.status as TicketStatus | undefined,
      priority: args.priority as TicketPriority | undefined,
      title: args.title as string | undefined,
      body: args.body as string | undefined,
      needs_triage: args.needs_triage as boolean | undefined,
    },
    eventCtx,
  );
  return ok(`Ticket #${id} updated.`);
};

const handleTicketsComment: ToolDef['handler'] = (db, _ctx, eventCtx, args) => {
  const id = args.id as number;
  const body = args.body as string;
  if (!getTicket(db, id)) return fail(`Ticket #${id} not found`);
  writeEvent(db, { ...eventCtx, ticket_id: id, event: 'commented', payload: { body } });
  return ok(`Comment added to ticket #${id}.`);
};

const handleTicketsLink: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  // Links are written by orchestrator/write_branch, not read_only children.
  if (ctx.tier === 'read_only') {
    return fail(
      "Tier 'read_only' may not write ticket links. Use orchestrator or write_branch tier.",
    );
  }
  const fromTicket = args.from_ticket as number;
  const toTicket = args.to_ticket as number;
  const rel = args.rel as LinkRel;
  const note = args.note as string | undefined;
  try {
    createLink(db, { from_ticket: fromTicket, to_ticket: toTicket, rel, note: note ?? null });
    return ok(`Linked #${fromTicket} →[${rel}]→ #${toTicket}.`);
  } catch (ex) {
    return fail(ex instanceof Error ? ex.message : String(ex));
  }
};

const handleTicketsClose: ToolDef['handler'] = (db, ctx, eventCtx, args) => {
  const id = args.id as number;
  // Policy: the same close rules as a human's; closeTicket
  // suppresses the fingerprint on wontfix.
  const refusal = closeAs(
    db,
    'agent',
    id,
    args.status as TerminalTicketStatus,
    String(args.resolution ?? ''),
    { ...eventCtx, closed_pulse: ctx.pulseId },
  );
  if (refusal) return fail(refusal.replace(/^#(\d+) not found$/, 'Ticket #$1 not found'));
  return ok(`Ticket #${id} closed as '${String(args.status)}'.`);
};

const handlePriorArt: ToolDef['handler'] = (db, ctx, eventCtx, args) => {
  const title = args.title as string;
  const body = args.body as string | undefined;
  const fromTicketId = args.from_ticket_id as number | undefined;
  const files = args.files as string[] | undefined;
  const fingerprint = args.fingerprint as string | undefined;

  const results = priorArt(
    db,
    { title, body, files, fingerprint: fingerprint ?? null },
    {
      fromTicketId,
      ctx: ctx.tier === 'orchestrator' ? eventCtx : undefined,
    },
  );
  return ok(JSON.stringify(results, null, 2));
};

const handleEscalate: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  if (!ctx.agentId) return fail('escalate requires LANTERN_AGENT_ID (daemon must inject it)');
  const severity = args.severity as EscalationSeverity;
  const question = args.question as string;
  const context = args.context as string | undefined;
  const options = args.options as string[] | undefined;
  const ticketId = args.ticket_id as number | undefined;
  try {
    const id = createEscalation(db, {
      agentId: ctx.agentId,
      pulseId: ctx.pulseId,
      ticketId: ticketId ?? null,
      severity,
      question,
      context: context ?? null,
      options: options ?? null,
    });
    return ok(JSON.stringify({ id }));
  } catch (ex) {
    return fail(ex instanceof Error ? ex.message : String(ex));
  }
};

export const TICKET_TOOLS: ToolDef[] = [
  {
    name: 'tickets_search',
    description:
      'Search tickets by full-text query and/or status filters. Returns id, title, status, priority, age.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search query (FTS5)' },
        status: {
          type: 'string',
          enum: [...TICKET_STATUSES],
        },
        needs_triage: { type: 'boolean' },
        limit: { type: 'number', description: 'Maximum results (default 20)' },
      },
    },
    tier: 'all',
    handler: handleTicketsSearch,
  },

  {
    name: 'tickets_get',
    description: 'Get a ticket by id. Returns the full ticket row, event history, and links.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number', description: 'Ticket id' },
      },
    },
    tier: 'all',
    handler: handleTicketsGet,
  },

  {
    name: 'tickets_create',
    description:
      'Create a ticket. Runs prior_art automatically and attaches relates_to links. Returns the new ticket id.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'title', 'body', 'origin'],
      properties: {
        kind: {
          type: 'string',
          enum: ['bug', 'enhancement', 'chore', 'docs', 'investigation', 'release', 'question'],
        },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown body' },
        origin: {
          type: 'string',
          enum: [
            'human',
            'collector:email',
            'collector:logs',
            'collector:docs',
            'collector:ci',
            'agent:self',
            'agent:child',
          ],
        },
        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
        needs_triage: { type: 'boolean' },
        fingerprint: { type: 'string' },
        origin_ref: { type: 'string' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Touched file paths stored for prior-art file-overlap boost',
        },
      },
    },
    tier: 'all',
    handler: handleTicketsCreate,
  },

  {
    name: 'tickets_update',
    description: "Update a ticket's status, priority, body, or title. Writes a ticket_events row.",
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number' },
        status: {
          type: 'string',
          enum: ['open', 'triage', 'staffed', 'in_review', 'blocked'],
          description: 'Non-terminal only; close with tickets_close',
        },
        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
        title: { type: 'string' },
        body: { type: 'string' },
        needs_triage: { type: 'boolean' },
      },
    },
    tier: 'all',
    handler: handleTicketsUpdate,
  },

  {
    name: 'tickets_comment',
    description: 'Append a comment to a ticket. Writes a ticket_events row with event=commented.',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'number' },
        body: { type: 'string', description: 'Comment text (Markdown)' },
      },
    },
    tier: 'all',
    handler: handleTicketsComment,
  },

  {
    name: 'tickets_link',
    description: 'Create a typed relationship between two tickets.',
    inputSchema: {
      type: 'object',
      required: ['from_ticket', 'to_ticket', 'rel'],
      properties: {
        from_ticket: { type: 'number' },
        to_ticket: { type: 'number' },
        rel: {
          type: 'string',
          enum: ['duplicates', 'relates_to', 'caused_by', 'blocks', 'supersedes'],
        },
        note: { type: 'string' },
      },
    },
    tier: 'all',
    handler: handleTicketsLink,
  },

  {
    name: 'tickets_close',
    description:
      'Close a ticket as closed, wontfix, or duplicate. Resolution is required and non-empty — it feeds prior-art search.',
    inputSchema: {
      type: 'object',
      required: ['id', 'status', 'resolution'],
      properties: {
        id: { type: 'number' },
        status: { type: 'string', enum: [...TERMINAL_TICKET_STATUSES] },
        resolution: {
          type: 'string',
          description: 'Required. What was learned or done. Feeds prior-art search.',
        },
      },
    },
    tier: 'all',
    handler: handleTicketsClose,
  },

  {
    name: 'prior_art',
    description:
      'Find related tickets using FTS5 BM25 ranking, biased toward closed/resolved prior history. Returns top 5 with resolutions inlined.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        from_ticket_id: {
          type: 'number',
          description: 'Exclude this ticket and auto-write relates_to links for strong matches.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Touched file paths for file-overlap boost',
        },
        fingerprint: { type: 'string', description: 'Exact fingerprint for bonus ranking' },
      },
    },
    tier: 'all',
    handler: handlePriorArt,
  },

  {
    name: 'escalate',
    description: 'Raise a question for the human operator.',
    inputSchema: {
      type: 'object',
      required: ['severity', 'question'],
      properties: {
        severity: { type: 'string', enum: ['fyi', 'decide', 'blocking'] },
        question: { type: 'string' },
        context: { type: 'string', description: 'JSON: links, diffs, log excerpts' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Proposed choices for the human',
        },
        ticket_id: { type: 'number' },
      },
    },
    tier: 'all',
    handler: handleEscalate,
  },
];
