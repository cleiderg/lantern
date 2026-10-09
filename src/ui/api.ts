/**
 * `lantern ui` JSON API: route tables. GET routes read, POST routes act through
 * `actions.ts` — the same functions the CLI calls.
 */

import { pause, resume } from '../actions.ts';
import { runDoctor } from '../doctor.ts';
import {
  type ApiContext,
  type ApiResponse,
  fail,
  fromAction,
  ok,
  type Route,
} from './routes/kit.ts';
import { pulses, sessionAction, sessions, transcripts } from './routes/runs.ts';
import {
  agentAction,
  agentHealth,
  claude,
  claudeAction,
  metrics,
  status,
} from './routes/system.ts';
import {
  inbox,
  inboxAction,
  ticketAction,
  tickets,
  triage,
  triageAction,
} from './routes/tickets.ts';

export type { ApiContext, ApiResponse, Route };

/** Keyed by the first path segment after `/api/`. */
export const GET_ROUTES: Record<string, Route> = {
  claude,
  metrics,
  agents: agentHealth,
  status,
  inbox,
  triage,
  tickets,
  sessions,
  pulses,
  transcripts,
  doctor: ({ lanternDir }) => ok(runDoctor({ lanternDir })),
  overview,
};

/**
 * One round trip per refresh — the chrome's status plus the current
 * view's data. `view` names a GET route; repeated `p` are its path segments;
 * the other query parameters pass through. A view's own error passes through.
 */
function overview(ctx: ApiContext): ApiResponse {
  const name = ctx.query.get('view');
  const head = status(ctx).json;
  if (!name) return ok({ status: head, view: null });
  const route =
    name !== 'overview' && Object.hasOwn(GET_ROUTES, name) ? GET_ROUTES[name] : undefined;
  if (!route) return fail(404, `unknown view '${name}'`);
  const r = route({ ...ctx, params: ctx.query.getAll('p') });
  return r.status === 200 ? ok({ status: head, view: r.json }) : r;
}

export const POST_ROUTES: Record<string, Route> = {
  claude: claudeAction,
  agents: agentAction,
  inbox: inboxAction,
  triage: triageAction,
  tickets: ticketAction,
  sessions: sessionAction,
  pause: ({ db, lanternDir }) => fromAction(pause(db, lanternDir)),
  resume: ({ db, lanternDir }) => fromAction(resume(db, lanternDir)),
};
