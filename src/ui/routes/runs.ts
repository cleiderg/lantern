/**
 * What ran: `/api/sessions`, `/api/pulses`, `/api/transcripts`, and killing a
 * session.
 */

import { killSessionAction } from '../../actions.ts';
import { listAgents } from '../../agent.ts';
import type { Db } from '../../db.ts';
import { getPulseFindings, getRecentPulses } from '../../store/pulses.ts';
import { listSessions } from '../../store/sessions.ts';
import { orchestratorTranscriptPath, summarizeTranscript } from '../../transcripts.ts';
import type { Pulse, Session } from '../../types.ts';
import {
  type ApiContext,
  type ApiResponse,
  fail,
  fromAction,
  idParam,
  ok,
  paged,
  pageParam,
} from './kit.ts';

export function sessions({ db, query }: ApiContext): ApiResponse {
  const live = query.get('live') === '1';
  const page = pageParam(query);
  if (page !== null && typeof page !== 'number') return page;
  if (page === null) return ok(withStructured(db, listSessions(db, { live })));
  const p = paged(page, (limit, offset) => listSessions(db, { live, limit, offset }));
  return ok({ ...p, rows: withStructured(db, p.rows) });
}

export function pulses({ db, params }: ApiContext): ApiResponse {
  if (params.length > 0) {
    const id = idParam(params);
    if (typeof id !== 'number') return id;
    const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(id) as Pulse | undefined;
    if (!pulse) return fail(404, `pulse #${id} not found`);
    const rows = db
      .prepare('SELECT * FROM sessions WHERE pulse_id = ? ORDER BY started_at')
      .all(id) as Session[];
    return ok({ pulse, findings: getPulseFindings(db, id), sessions: withStructured(db, rows) });
  }
  const recent = listAgents(db)
    .flatMap((a) => getRecentPulses(db, a.id, 24))
    .sort((x, y) => (x.started_at < y.started_at ? 1 : -1))
    .map((p) => ({ ...p, findings: getPulseFindings(db, p.id) }));
  return ok(recent);
}

/**
 * Transcripts. The file path always comes from the DB (a
 * session's `transcript_path`) or the pulse-id convention — never from the URL.
 */
export function transcripts({ db, lanternDir, params, query }: ApiContext): ApiResponse {
  const [kind, raw] = params;
  // `?from=<byte offset>` returns only what a live run wrote since.
  const from = Number(query.get('from') ?? 0);
  if (!Number.isSafeInteger(from) || from < 0) return fail(400, 'from must be a byte offset');
  let path: string | null = null;
  let session: Session | undefined;
  if (kind === 'pulse') {
    const id = idParam([raw ?? '']);
    if (typeof id !== 'number') return id;
    path = orchestratorTranscriptPath(lanternDir, id);
  } else if (kind === 'session') {
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(raw ?? '') as
      | Session
      | undefined;
    path = session?.transcript_path ?? null;
  } else {
    return fail(404, 'not found');
  }
  const summary = path ? summarizeTranscript(path, from) : null;
  if (!summary && !session) return fail(404, 'no transcript saved');
  // A known session with no transcript yet (just spawned) still has a page.
  return ok({
    path,
    ...(summary ?? {
      init: null,
      steps: [],
      denials: [],
      end: null,
      unparsedLines: 0,
      nextOffset: 0,
      reset: false,
    }),
    missing: !summary,
    session: session ? withStructured(db, [session])[0] : null,
  });
}

export function sessionAction({ db, params }: ApiContext): ApiResponse {
  if (!params[0] || params[1] !== 'kill') return fail(404, 'not found');
  return fromAction(killSessionAction(db, params[0]));
}

/**
 * A session's structured App. C result lives in its ticket's `completed`
 * event — the event log is the record — so it is joined in here, not stored twice.
 */
type FollowUp = { id: number; title: string; status: string };

export function withStructured(
  db: Db,
  rows: Session[],
): Array<Session & { structured: unknown; followUps: FollowUp[] }> {
  const stmt = db.prepare(
    `SELECT payload FROM ticket_events WHERE session_id = ? AND event = 'completed' ORDER BY id DESC LIMIT 1`,
  );
  // the tickets a child filed (App. C follow-ups) carry its session on their 'created' event.
  const follow = db.prepare(
    `SELECT t.id, t.title, t.status FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
     WHERE e.session_id = ? AND e.event = 'created' ORDER BY t.id`,
  );
  return rows.map((r) => {
    const ev = stmt.get(r.id) as { payload: string | null } | undefined;
    let structured: unknown = null;
    try {
      structured = ev?.payload
        ? ((JSON.parse(ev.payload) as { structured?: unknown }).structured ?? null)
        : null;
    } catch {
      structured = null;
    }
    return { ...r, structured, followUps: follow.all(r.id) as FollowUp[] };
  });
}
