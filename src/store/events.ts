import type { Db } from '../db.ts';
import type { EventContext } from '../types.ts';

export type WriteEventInput = EventContext & {
  ticket_id: number;
  event: string;
  payload?: unknown;
};

/**
 * Append one row to ticket_events.
 * Called inside a transaction by every ticket-mutating function — never standalone.
 */
export function writeEvent(db: Db, input: WriteEventInput): void {
  db.prepare(`
    INSERT INTO ticket_events (ticket_id, pulse_id, session_id, actor, event, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.ticket_id,
    input.pulse_id ?? null,
    input.session_id ?? null,
    input.actor,
    input.event,
    input.payload !== undefined ? JSON.stringify(input.payload) : null,
  );
}
