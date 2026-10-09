import type { Db } from '../db.ts';
import type { LinkRel, TicketLink } from '../types.ts';

export type CreateLinkInput = {
  from_ticket: number;
  to_ticket: number;
  rel: LinkRel;
  note?: string | null;
};

export function createLink(db: Db, input: CreateLinkInput): void {
  db.prepare(`
    INSERT OR IGNORE INTO ticket_links (from_ticket, to_ticket, rel, note)
    VALUES (?, ?, ?, ?)
  `).run(input.from_ticket, input.to_ticket, input.rel, input.note ?? null);
}

export function getLinks(db: Db, ticketId: number): TicketLink[] {
  return db
    .prepare(
      `SELECT * FROM ticket_links
       WHERE from_ticket = ? OR to_ticket = ?
       ORDER BY created_at`,
    )
    .all(ticketId, ticketId) as TicketLink[];
}
