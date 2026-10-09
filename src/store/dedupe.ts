/**
 * The one answer to "file a ticket for this fingerprint now?".
 * The log scan and ci.watch each had their own version, and they disagreed:
 * ci treated any wontfix as quiet forever and ignored a 10× rate spike; the
 * log scan followed the noise rules (suppression with a TTL, which a spike overrides) but
 * forgot a human's wontfix. Every collector that files by fingerprint asks
 * here. (inbox.bugs dedupes by message id — a different question.)
 *
 *  - suppressed, and the rate has not spiked 10×         → don't file
 *  - a ticket with this fingerprint is still open         → don't file (open)
 *  - its newest ticket was closed as a duplicate of a
 *    ticket that is still open (following the chain) → don't file (tracked)
 *  - otherwise — never seen, fixed and back (a regression),
 *    or dismissed and its suppression lapsed              → file
 */

import type Database from 'better-sqlite3';
import { isTerminalTicket, TERMINAL_SQL } from '../types.ts';

export type FileDecision =
  | { file: true }
  | { file: false; reason: 'suppressed' }
  | { file: false; reason: 'open' | 'tracked'; ticketId: number };

export function shouldFile(
  db: Database.Database,
  fingerprint: string,
  obs: { suppressed: boolean; rate_spike: boolean },
): FileDecision {
  if (obs.suppressed && !obs.rate_spike) return { file: false, reason: 'suppressed' };
  const open = db
    .prepare(
      `SELECT id FROM tickets WHERE fingerprint = ? AND status NOT IN ${TERMINAL_SQL} LIMIT 1`,
    )
    .get(fingerprint) as { id: number } | undefined;
  if (open) return { file: false, reason: 'open', ticketId: open.id };
  const target = openDuplicateTarget(db, fingerprint);
  if (target !== null) return { file: false, reason: 'tracked', ticketId: target };
  return { file: true };
}

/**
 * The open ticket this fingerprint was closed as a duplicate of, if any.
 * Follows `duplicates` links from the fingerprint's newest ticket, ≤ 5 hops.
 */
export function openDuplicateTarget(db: Database.Database, fingerprint: string): number | null {
  const newest = db
    .prepare('SELECT id, status FROM tickets WHERE fingerprint = ? ORDER BY id DESC LIMIT 1')
    .get(fingerprint) as { id: number; status: string } | undefined;
  let cur = newest;
  for (let hop = 0; cur?.status === 'duplicate' && hop < 5; hop++) {
    cur = db
      .prepare(
        `SELECT t.id, t.status FROM ticket_links l JOIN tickets t ON t.id = l.to_ticket
         WHERE l.from_ticket = ? AND l.rel = 'duplicates' ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1`,
      )
      .get(cur.id) as { id: number; status: string } | undefined;
  }
  if (!cur || cur === newest || cur.status === 'duplicate') return null;
  return isTerminalTicket(cur.status) ? null : cur.id;
}
