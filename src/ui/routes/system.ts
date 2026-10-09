/**
 * The daemon and its agents: `/api/status`, agent health and settings, the
 * metrics, and the Claude connection.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentRunning, pulseNow, registerAgent, startAgent, stopAgent } from '../../actions.ts';
import { getAgent, listAgents } from '../../agent.ts';
import { runtimeSettings } from '../../agent-config.ts';
import { configChanges, EDITABLE, editAgentConfig, PAGE_CAPS } from '../../agent-edit.ts';
import { DEFAULT_DAILY_CEILING_USD } from '../../budget.ts';
import { claudeStatus, startClaudeTest } from '../../claude-status.ts';
import type { Db } from '../../db.ts';
import { checkDeadMan } from '../../deadman.ts';
import { metricsRows } from '../../format.ts';
import { computeMetrics } from '../../store/metrics.ts';
import { getLiveChildrenCount } from '../../store/pulses.ts';
import { getDailyUsage, utcDay } from '../../store/usage.ts';
import type { Agent } from '../../types.ts';
import { TERMINAL_SQL } from '../../types.ts';
import { explainSkip, projectSpend } from '../health.ts';
import { type ApiContext, type ApiResponse, fail, fromAction, ok, text } from './kit.ts';

/** The morning screen: `lantern status` as data. */
/** One agent as the page shows it: state, liveness, ceiling, latest skip. */
type Cost = { at: string; usd: number };

/** Every cost that reached usage_daily: pulses and child sessions, at close. */
function todaysCosts(db: Db): Cost[] {
  return db
    .prepare(
      `SELECT ended_at AS at, cost_usd AS usd FROM pulses WHERE ended_at IS NOT NULL AND cost_usd > 0
       UNION ALL
       SELECT ended_at, cost_usd FROM sessions WHERE ended_at IS NOT NULL AND cost_usd > 0`,
    )
    .all() as Cost[];
}

function agentView(db: Db, lanternDir: string, a: Agent, now: number, costs: Cost[]) {
  let dailyCeilingUsd: number | null = null;
  let configError: string | null = null;
  try {
    dailyCeilingUsd = runtimeSettings(a).dailyCeilingUsd;
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  // The agent's latest pulse, if it was a gate refusal: what the card explains.
  const last = db
    .prepare(
      'SELECT id, status, error, started_at FROM pulses WHERE agent_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(a.id) as
    | { id: number; status: string; error: string | null; started_at: string }
    | undefined;
  const lastSkip =
    last?.status === 'skipped' && last.error
      ? { pulseId: last.id, at: last.started_at, reason: last.error, ...explainSkip(last.error) }
      : null;
  return {
    ...a,
    dailyCeilingUsd,
    configError,
    lastSkip,
    // Daily spend is shared by every agent, checked against this agent's ceiling.
    spend: projectSpend({
      costs,
      ceilingUsd: dailyCeilingUsd ?? DEFAULT_DAILY_CEILING_USD,
      now: new Date(now),
    }),
    // A dead-man check means something only for an agent that should be pulsing.
    deadman: a.state === 'running' ? checkDeadMan(a, now) : { stale: false },
    ...agentRunning(lanternDir, a.id),
    liveSessions: getLiveChildrenCount(db, a.id),
  };
}

export function status({ db, lanternDir }: ApiContext): ApiResponse {
  const now = Date.now();
  const costs = todaysCosts(db);
  const agents = listAgents(db).map((a) => agentView(db, lanternDir, a, now, costs));
  const unanswered = (
    db.prepare('SELECT count(*) AS n FROM escalations WHERE answered_at IS NULL').get() as {
      n: number;
    }
  ).n;
  return ok({
    paused: existsSync(join(lanternDir, 'PAUSED')),
    agents,
    spend: getDailyUsage(db, utcDay()),
    // Started children (gate 3's count) and queued ones, which are not "live".
    liveSessions: agents.reduce((n, a) => n + a.liveSessions, 0),
    queuedSessions: (
      db.prepare(`SELECT count(*) AS n FROM sessions WHERE status = 'starting'`).get() as {
        n: number;
      }
    ).n,
    unanswered,
    needsTriage: (
      db
        .prepare(
          `SELECT count(*) AS n FROM tickets WHERE needs_triage = 1 AND status NOT IN ${TERMINAL_SQL}`,
        )
        .get() as { n: number }
    ).n,
  });
}

/**
 * `agents/:id`: the health picture. Gate refusals of the last 24 h,
 * explained; today's spend by hour with a projected trip time (spend is shared
 * by all agents, as gate 2 counts it); findings per action over 24 h; the
 * effective config; operational settings change through `agents/:id/config`.
 */
export function agentHealth({ db, lanternDir, params }: ApiContext): ApiResponse {
  const a = getAgent(db, params[0] ?? '');
  if (!a) return fail(404, `agent '${params[0] ?? ''}' not found`);
  const now = new Date();
  const view = agentView(db, lanternDir, a, now.getTime(), todaysCosts(db));
  const since = new Date(now.getTime() - 86_400_000).toISOString();

  // A gate refusal is a skipped pulse with a reason; a turn that ran but
  // verified nothing also ends 'skipped', with no reason — not a skip here.
  const skips = (
    db
      .prepare(
        `SELECT id, started_at, error FROM pulses
         WHERE agent_id = ? AND status = 'skipped' AND error IS NOT NULL AND started_at >= ?
         ORDER BY id DESC LIMIT 200`,
      )
      .all(a.id, since) as { id: number; started_at: string; error: string | null }[]
  ).map((p) => ({
    pulseId: p.id,
    at: p.started_at,
    reason: p.error ?? '',
    ...explainSkip(p.error ?? ''),
  }));

  const spend = view.spend;

  const findings24h = db
    .prepare(
      `SELECT f.action_key,
              sum(f.outcome = 'clean') AS clean, sum(f.outcome = 'finding') AS finding,
              sum(f.outcome = 'skipped') AS skipped, sum(f.outcome = 'error') AS error
       FROM pulse_findings f JOIN pulses p ON p.id = f.pulse_id
       WHERE p.agent_id = ? AND p.started_at >= ?
       GROUP BY f.action_key ORDER BY f.action_key`,
    )
    .all(a.id, since);

  let config: unknown = null;
  try {
    const c = runtimeSettings(a).config;
    if (c) {
      config = {
        configPath: a.config_path,
        heartbeatSeconds: c.heartbeatSeconds,
        maxChildren: c.maxChildren,
        workdir: c.workdir,
        mission: c.mission,
        budget: c.budget,
        quietHours: c.quietHours,
        allowDirty: c.allowDirty,
        logSources: c.logSources,
        inboxSource: c.inboxSource,
        actions: c.actions,
        noiseAllowlist: c.noiseAllowlist,
        testCommands: c.testCommands,
        ciWatch: c.ciWatch,
      };
    }
  } catch {
    // configError on the agent says why
  }
  return ok({
    agent: view,
    skips,
    spend,
    findings24h,
    config,
    // What the page may change, and what it did.
    editable: { fields: EDITABLE, caps: PAGE_CAPS },
    configChanges: configChanges(lanternDir, a.id),
  });
}

/** The six metrics over `?days=` (default 30). */
export function metrics({ db, query }: ApiContext): ApiResponse {
  const raw = query.get('days');
  const days = raw === null ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    return fail(400, 'days must be a whole number from 1 to 3650');
  }
  const m = computeMetrics(db, { days });
  // Rows worded once, for the CLI and the page alike.
  return ok({ ...m, rows: metricsRows(m) });
}

/** The Claude connection: status, read-only. */
export function claude({ db, lanternDir }: ApiContext): ApiResponse {
  return ok(claudeStatus(db, lanternDir));
}

/** `claude/test`: one sandboxed test turn, started in the background (202). */
export function claudeAction({ db, lanternDir, params, claudeRunner }: ApiContext): ApiResponse {
  if (params[0] !== 'test' || params.length !== 1) return fail(404, 'not found');
  const r = startClaudeTest(db, lanternDir, claudeRunner);
  if (!r.started) return fail(409, r.error ?? 'not started');
  return { status: 202, json: { messages: ['test turn started — about $0.01'] } };
}

/** Run Lantern from the page: `agents/:id/{start,stop,pulse}`, `agents/register`. */
export function agentAction({ db, lanternDir, params, body, launcher }: ApiContext): ApiResponse {
  if (params[0] === 'register' && params.length === 1) {
    const path = text(body, 'path');
    return typeof path === 'string' ? fromAction(registerAgent(db, path.trim())) : path;
  }
  const id = params[0];
  if (!id) return fail(404, 'not found');
  switch (params[1]) {
    case 'config': {
      // The operational settings, from the page.
      const { confirm, ...patch } = body;
      const r = editAgentConfig(db, lanternDir, id, patch, {
        actor: 'human (ui)',
        confirm: confirm === true,
      });
      if (r.ok) return ok({ messages: r.messages, restartNeeded: r.restartNeeded });
      if (r.needsConfirm) return { status: 409, json: { error: r.error, needsConfirm: true } };
      return fail(/not found/.test(r.error) ? 404 : 400, r.error);
    }
    case 'start':
      return fromAction(startAgent(db, lanternDir, id, launcher));
    case 'stop':
      return fromAction(stopAgent(db, lanternDir, id));
    case 'pulse':
      return fromAction(pulseNow(db, lanternDir, id, launcher));
    default:
      return fail(404, 'not found');
  }
}
