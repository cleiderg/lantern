/**
 * What changed, for the UI's Server-Sent Events.
 *
 * `snapshot()` reduces each area of the store to a short fingerprint; the
 * event stream compares consecutive snapshots and names the areas that moved.
 * Events carry only those names — never ticket text or any other collected
 * content (Law 8); the page refetches through the normal, token-checked API.
 * Every ticket mutation writes a ticket_event, so its max id is a complete
 * change marker for tickets.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentRunning } from '../actions.ts';
import { lastTest, testRunning } from '../claude-status.ts';
import type { Db } from '../db.ts';
import { utcDay } from '../store/usage.ts';
import { orchestratorTranscriptPath } from '../transcripts.ts';
import { LIVE_SQL } from '../types.ts';

export const DOMAINS = [
  'pulses',
  'tickets',
  'escalations',
  'sessions',
  'agents',
  'spend',
  'paused',
  'transcripts',
  'claude',
] as const;
export type Domain = (typeof DOMAINS)[number];
export type Snapshot = Record<Domain, string>;

const size = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

/**
 * The transcripts still being written — live children's and running
 * pulses' orchestrator — by size. A run appends as it goes, so a new line is a
 * new size; the page then asks for the bytes after what it already has.
 */
function liveTranscripts(db: Db, lanternDir: string): string {
  const sessions = db
    .prepare(
      `SELECT id, transcript_path AS path FROM sessions
       WHERE status IN ${LIVE_SQL} AND transcript_path IS NOT NULL`,
    )
    .all() as { id: string; path: string }[];
  const pulses = db.prepare(`SELECT id FROM pulses WHERE status = 'running'`).all() as {
    id: number;
  }[];
  return [
    ...sessions.map((s) => `${s.id}:${size(s.path)}`),
    ...pulses.map((p) => `p${p.id}:${size(orchestratorTranscriptPath(lanternDir, p.id))}`),
  ].join(',');
}

const one = (db: Db, sql: string, ...args: unknown[]): string =>
  String(Object.values((db.prepare(sql).get(...args) as Record<string, unknown>) ?? {})[0] ?? '');

export function snapshot(db: Db, lanternDir: string): Snapshot {
  const agents = db.prepare('SELECT id FROM agents ORDER BY id').all() as { id: string }[];
  return {
    pulses: one(
      db,
      `SELECT count(*) || ':' || coalesce(max(id), 0) || ':' ||
              coalesce((SELECT status || cost_usd FROM pulses ORDER BY id DESC LIMIT 1), '') || ':' ||
              coalesce((SELECT max(id) FROM pulse_findings), 0)
       FROM pulses`,
    ),
    tickets: one(
      db,
      `SELECT (SELECT count(*) FROM tickets) || ':' || coalesce((SELECT max(id) FROM ticket_events), 0)`,
    ),
    escalations: one(db, `SELECT count(*) || ':' || count(answered_at) FROM escalations`),
    sessions: one(
      db,
      `SELECT count(*) || ':' || coalesce(group_concat(id || status || coalesce(ended_at, '')), '')
       FROM (SELECT id, status, ended_at FROM sessions ORDER BY started_at DESC LIMIT 50)`,
    ),
    agents:
      one(
        db,
        `SELECT coalesce(group_concat(id || state || coalesce(last_pulse_at, '') || coalesce(next_pulse_at, '') || coalesce(paused_reason, '')), '')
         FROM agents`,
      ) + agents.map((a) => (agentRunning(lanternDir, a.id).running ? 'R' : '-')).join(''),
    spend: one(
      db,
      `SELECT coalesce((SELECT cost_usd || ':' || pulses || ':' || sessions FROM usage_daily WHERE day = ?), '')`,
      utcDay(),
    ),
    paused: existsSync(join(lanternDir, 'PAUSED')) ? '1' : '0',
    transcripts: liveTranscripts(db, lanternDir),
    claude: `${lastTest()?.at ?? ''}:${testRunning() ? 1 : 0}`,
  };
}

/** The areas whose fingerprint differs between two snapshots. */
export function changedDomains(before: Snapshot, after: Snapshot): Domain[] {
  return DOMAINS.filter((d) => before[d] !== after[d]);
}
