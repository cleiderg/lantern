import type { Db } from '../db.ts';
import type {
  EventContext,
  Ticket,
  TicketKind,
  TicketOrigin,
  TicketPriority,
  TicketStatus,
} from '../types.ts';
import { writeEvent } from './events.ts';
import { suppressFingerprint } from './observations.ts';

// ─── Input types ──────────────────────────────────────────────────────────────

export type CreateTicketInput = {
  agent_id?: string | null;
  kind: TicketKind;
  title: string;
  body: string;
  origin: TicketOrigin;
  origin_ref?: string | null;
  fingerprint?: string | null;
  needs_triage?: boolean;
  priority?: TicketPriority;
  repo?: string | null;
  opened_pulse?: number | null;
};

export type UpdateTicketPatch = {
  status?: TicketStatus;
  priority?: TicketPriority;
  title?: string;
  body?: string;
  branch?: string | null;
  pr_url?: string | null;
  needs_triage?: boolean;
};

export type TicketFilters = {
  status?: TicketStatus | TicketStatus[];
  search?: string; // FTS query — handled by prior_art, not here
  needs_triage?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'priority';
};

// ─── Reads ────────────────────────────────────────────────────────────────────

export function getTicket(db: Db, id: number): Ticket | undefined {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined;
}

export function listTickets(db: Db, filters: TicketFilters = {}): Ticket[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }

  if (filters.needs_triage !== undefined) {
    conditions.push('needs_triage = ?');
    params.push(filters.needs_triage ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderCol =
    filters.orderBy === 'priority'
      ? "CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END, created_at"
      : filters.orderBy === 'updated_at'
        ? 'updated_at DESC'
        : 'created_at DESC';
  let limit = '';
  if (filters.limit !== undefined) {
    limit = 'LIMIT ? OFFSET ?';
    params.push(filters.limit, filters.offset ?? 0);
  }

  // id breaks ties, so pages of rows created in the same second never overlap.
  return db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY ${orderCol}, id DESC ${limit}`)
    .all(...params) as Ticket[];
}

export function getTicketEvents(db: Db, ticketId: number): import('../types.ts').TicketEvent[] {
  return db
    .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at')
    .all(ticketId) as import('../types.ts').TicketEvent[];
}

// ─── Writes (each atomic: row mutation + event in one transaction) ─────────────

export function createTicket(db: Db, input: CreateTicketInput, ctx: EventContext): number {
  return db.transaction(() => {
    const result = db
      .prepare(`
      INSERT INTO tickets
        (agent_id, kind, title, body, origin, origin_ref, fingerprint,
         needs_triage, priority, repo, opened_pulse)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.agent_id ?? null,
        input.kind,
        input.title,
        input.body,
        input.origin,
        input.origin_ref ?? null,
        input.fingerprint ?? null,
        input.needs_triage ? 1 : 0,
        input.priority ?? 'p3',
        input.repo ?? null,
        input.opened_pulse ?? null,
      );

    const id = Number(result.lastInsertRowid);
    writeEvent(db, { ...ctx, ticket_id: id, event: 'created' });
    return id;
  })();
}

export function updateTicket(
  db: Db,
  id: number,
  patch: UpdateTicketPatch,
  ctx: EventContext,
): void {
  db.transaction(() => {
    const setClauses: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (patch.status !== undefined) {
      setClauses.push('status = ?');
      params.push(patch.status);
    }
    if (patch.priority !== undefined) {
      setClauses.push('priority = ?');
      params.push(patch.priority);
    }
    if (patch.title !== undefined) {
      setClauses.push('title = ?');
      params.push(patch.title);
    }
    if (patch.body !== undefined) {
      setClauses.push('body = ?');
      params.push(patch.body);
    }
    if (patch.branch !== undefined) {
      setClauses.push('branch = ?');
      params.push(patch.branch);
    }
    if (patch.pr_url !== undefined) {
      setClauses.push('pr_url = ?');
      params.push(patch.pr_url);
    }
    if (patch.needs_triage !== undefined) {
      setClauses.push('needs_triage = ?');
      params.push(patch.needs_triage ? 1 : 0);
    }

    if (setClauses.length === 1) return; // nothing to update

    params.push(id);
    db.prepare(`UPDATE tickets SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

    const eventName = patch.status !== undefined ? 'status_changed' : 'updated';
    writeEvent(db, {
      ...ctx,
      ticket_id: id,
      event: eventName,
      payload: patch,
    });
  })();
}

// ─── Close (closed / wontfix / duplicate) ────────────────────────────────────

export type CloseTicketInput = {
  status: 'closed' | 'wontfix' | 'duplicate';
  resolution: string;
  closed_pulse?: number | null;
};

/**
 * Set (replace) the touched-file projection for a ticket.
 * Called by the tool layer when a session closes and we know which paths were modified.
 * Deletes all existing rows for the ticket then inserts the new set atomically.
 */
export function setTicketFiles(db: Db, ticketId: number, paths: string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM ticket_files WHERE ticket_id = ?').run(ticketId);
    const insert = db.prepare('INSERT INTO ticket_files (ticket_id, path) VALUES (?, ?)');
    for (const path of paths) {
      insert.run(ticketId, path);
    }
  })();
}

/**
 * Close, wontfix, or duplicate a ticket. A wontfix also suppresses the
 * ticket's fingerprint — the one place that happens, for every caller.
 * Throws — before touching any row — if `resolution` is empty or whitespace.
 * Closing a ticket requires a non-empty `resolution`.
 */
export function closeTicket(db: Db, id: number, input: CloseTicketInput, ctx: EventContext): void {
  if (!input.resolution.trim()) {
    throw new Error(`cannot close ticket #${id} without a non-empty resolution`);
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE tickets
      SET status      = ?,
          resolution  = ?,
          closed_at   = datetime('now'),
          closed_pulse = ?,
          updated_at  = datetime('now')
      WHERE id = ?
    `).run(input.status, input.resolution.trim(), input.closed_pulse ?? null, id);

    writeEvent(db, {
      ...ctx,
      ticket_id: id,
      event: 'closed',
      payload: { status: input.status, resolution: input.resolution.trim() },
    });

    // A wontfix suppresses its fingerprint, whoever closes it, so the same
    // pattern does not re-surface until the TTL lapses or its rate spikes 10×.
    // This used to live only in the agent's tickets_close tool, so a human's
    // dismissal (Triage, the page, the CLI) came back.
    if (input.status === 'wontfix') {
      const fp = (
        db.prepare('SELECT fingerprint FROM tickets WHERE id = ?').get(id) as
          | { fingerprint: string | null }
          | undefined
      )?.fingerprint;
      if (fp) suppressFingerprint(db, fp, `ticket #${id} closed as wontfix`);
    }
  })();
}

/**
 * Reopen a closed / wontfix / duplicate ticket. The resolution is
 * cleared on the row — it stays in the `closed` event, which is the record —
 * and a `reopened` event says who reopened it and why.
 */
export function reopenTicket(db: Db, id: number, reason: string, ctx: EventContext): void {
  if (!reason.trim()) throw new Error(`cannot reopen ticket #${id} without a reason`);
  db.transaction(() => {
    db.prepare(`
      UPDATE tickets
      SET status = 'open', resolution = NULL, closed_at = NULL, closed_pulse = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    writeEvent(db, {
      ...ctx,
      ticket_id: id,
      event: 'reopened',
      payload: { reason: reason.trim() },
    });
  })();
}
