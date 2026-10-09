// Lantern UI: the status vocabularies, mirrored from src/types.ts.
// The page has no build step, so it cannot import the TypeScript;
// src/vocab.test.ts fails if these drift from types.ts or the schema.

export const TICKET_STATUSES = [
  'open',
  'triage',
  'staffed',
  'in_review',
  'blocked',
  'closed',
  'wontfix',
  'duplicate',
];

/** Statuses that end a ticket. */
export const TERMINAL_TICKET_STATUSES = ['closed', 'wontfix', 'duplicate'];

/** A session that is queued or still running. */
export const LIVE_SESSION_STATUSES = ['starting', 'running', 'waiting'];
