/**
 * staff_ticket executor: spawn/poll/reap child sessions.
 *
 * Called from daemon.ts after each orchestrator turn (the "reap" phase).
 * Finds sessions with status='starting', spawns them.
 * Finds sessions with status='running', polls them and records results.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { DEFAULT_DAILY_CEILING_USD, PER_SESSION_CEILING_USD } from '../budget.ts';
import { checkDailySpend } from '../gates.ts';
import { writeSessionMcpConfig } from '../mcp/config.ts';
import { execText } from '../proc.ts';
import { publishBranch, pushReleaseTag } from '../pull-request.ts';
import { hasApproval } from '../store/escalations.ts';
import { writeEvent } from '../store/events.ts';
import { createLink } from '../store/links.ts';
import { getLiveChildrenCount } from '../store/pulses.ts';
import { getLiveSessions, updateSession } from '../store/sessions.ts';
import { createTicket, getTicket, updateTicket } from '../store/tickets.ts';
import { enforceDailyCeiling, recordDailyUsage } from '../store/usage.ts';
import { sessionTranscriptPath } from '../transcripts.ts';
import type { Agent } from '../types.ts';
import { oneLine } from '../untrusted.ts';
import {
  createWorktree,
  defaultBranch,
  destroyWorktree,
  installPushGuard,
  pushGuardEnv,
  worktreePath,
} from '../worktree.ts';
import { agentTestCommands, buildChildPrompt, priorWork } from './child-prompt.ts';
import { CHILD_RESULT_SCHEMA, parseChildResult } from './child-result.ts';
import { ClaudeCodeHarness } from './claude-code.ts';
import { decideCompletion } from './completion.ts';
import { tierFlags } from './tiers.ts';
import type { HarnessAdapter } from './types.ts';

type LiveEntry = { harness: HarnessAdapter; handleId: string };

/**
 * The children this process started (these were module-level
 * singletons, reset by a test hook). Handles live with the process that
 * spawned them — a daemon restart loses them, which `forget` reproduces.
 */
export class LiveSessions {
  /** sessionId → the harness handle that can poll or kill it. */
  readonly handles = new Map<string, LiveEntry>();
  /**
   * One completion per started child. A short-lived process (`lantern pulse
   * --now`) must not exit before its children are recorded, or they are
   * orphaned exactly as a daemon restart orphans them.
   */
  readonly pending = new Set<Promise<void>>();

  /** Resolves once every child session started by this process has been recorded. */
  async waitForCompletions(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Drop every handle, as a daemon restart does. */
  forget(): void {
    this.handles.clear();
  }
}

/** This process's children: the default for every entry point below. */
export const processSessions = new LiveSessions();

/** Resolves once every child session started by `live` has been recorded. */
export const waitForCompletions = (live: LiveSessions = processSessions) =>
  live.waitForCompletions();

export async function reapSessions(
  db: Database.Database,
  agent: Agent,
  lanternDir: string,
  pulseId: number,
  harness: HarnessAdapter = new ClaudeCodeHarness(),
  /** The agent's daily budget: spawn reservations and Law 7 trips use it. */
  dailyCeilingUsd: number = DEFAULT_DAILY_CEILING_USD,
  live: LiveSessions = processSessions,
): Promise<void> {
  const sessions = getLiveSessions(db, agent.id);

  for (const session of sessions) {
    if (session.status === 'running') await pollSession(db, agent, session.id, lanternDir, live);
  }
  for (const session of sessions) {
    if (session.status !== 'starting') continue;
    // Gate 3 and Law 7 hold per spawn, not only per pulse: a single
    // pulse can queue any number of sessions. What doesn't fit
    // stays queued for a later reap.
    if (getLiveChildrenCount(db, agent.id) >= agent.max_children) break;
    if (!checkDailySpend(db, dailyCeilingUsd, undefined, agent.id, PER_SESSION_CEILING_USD).ok)
      break;
    await spawnSession(db, agent, session.id, lanternDir, pulseId, harness, dailyCeilingUsd, live);
  }
}

async function spawnSession(
  db: Database.Database,
  agent: Agent,
  sessionId: string,
  lanternDir: string,
  pulseId: number,
  harness: HarnessAdapter,
  dailyCeilingUsd: number,
  live: LiveSessions,
): Promise<void> {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | { tier: string; ticket_id: number | null; label: string | null }
    | undefined;
  if (!session) return;

  const tier = session.tier as 'read_only' | 'write_branch' | 'release';

  // release tier requires an approved escalation before spawning — defense in
  // depth backstop; the primary gate is in handleStaffTicket.
  if (tier === 'release' && !(session.ticket_id !== null && hasApproval(db, session.ticket_id))) {
    // Can't spawn yet — leave as starting, it will be picked up next pulse
    return;
  }

  let cwd = agent.workdir;
  let env: Record<string, string> | undefined;

  if (tier === 'write_branch' || tier === 'release') {
    const wtPath = worktreePath(lanternDir, sessionId);
    const branchName = session.label
      ? `lantern/${session.label}-${sessionId.slice(0, 8)}`
      : `lantern/session-${sessionId.slice(0, 8)}`;
    try {
      createWorktree(agent.workdir, branchName, wtPath);
    } catch (e) {
      // Law 2: a write tier runs in its own worktree or not at all. This used
      // to fall back to agent.workdir — the operator's checkout.
      const reason = `worktree creation failed: ${e instanceof Error ? e.message : String(e)}`;
      failBeforeSpawn(db, agent, sessionId, session.ticket_id, pulseId, reason);
      return;
    }
    cwd = wtPath;
    updateSession(db, sessionId, { worktree: wtPath, branch: branchName });
    env = installPushGuard(agent.workdir, pushGuardDir(lanternDir, sessionId));
  }

  const ticket = session.ticket_id ? getTicket(db, session.ticket_id) : null;
  const testCommands = agentTestCommands(agent);
  const prompt = ticket
    ? buildChildPrompt(ticket, tier, {
        testCommands,
        ...(tier === 'read_only' ? {} : { prior: priorWork(db, ticket.id) }),
      })
    : `# Session ${sessionId}`;

  const mcpConfig = writeSessionMcpConfig(lanternDir, `session-${sessionId}`, {
    LANTERN_DIR: lanternDir,
    LANTERN_AGENT_ID: agent.id,
    LANTERN_PULSE_ID: String(pulseId),
    LANTERN_SESSION_ID: sessionId,
    LANTERN_TIER: tier,
    ...(session.ticket_id ? { LANTERN_TICKET_ID: String(session.ticket_id) } : {}),
  });

  const flags = tierFlags(tier, { testCommands });
  const transcriptPath = sessionTranscriptPath(lanternDir, pulseId, sessionId);
  updateSession(db, sessionId, { transcriptPath });

  const handle = await harness.run({
    prompt,
    cwd,
    env,
    tier,
    tools: flags.tools,
    transcriptPath,
    outputSchema: CHILD_RESULT_SCHEMA,
    allowedTools: flags.allowedTools,
    disallowedTools: flags.disallowedTools,
    mcpConfig,
    maxTurns: 30,
    timeoutMs: 30 * 60 * 1000, // 30 min per child session
    costCeilingUsd: PER_SESSION_CEILING_USD,
  });

  const pid = harness.getPid?.(handle.id);
  updateSession(db, sessionId, { status: 'running', pid: pid ?? null });
  const entry = { harness, handleId: handle.id };
  live.handles.set(sessionId, entry);

  // Update ticket to staffed
  if (session.ticket_id) {
    updateTicket(
      db,
      session.ticket_id,
      { status: 'staffed' },
      { actor: agent.id, pulse_id: pulseId, session_id: sessionId },
    );
    writeEvent(db, {
      ticket_id: session.ticket_id,
      actor: agent.id,
      event: 'staffed',
      payload: { session_id: sessionId, tier },
      pulse_id: pulseId,
      session_id: sessionId,
    });
  }

  // The close is recorded exactly once, from here. It used to be attached in
  // pollSession on every reap the session spanned, and every attachment fired
  // on completion — cost, `completed` event and ticket transition, N times
  //.
  const completion = recordCompletion(
    db,
    agent,
    sessionId,
    entry,
    lanternDir,
    dailyCeilingUsd,
    live,
  );
  live.pending.add(completion);
  void completion.finally(() => live.pending.delete(completion));
}

/** Per-session hooks dir for the push guard, beside the worktrees in lanternDir. */
function pushGuardDir(lanternDir: string, sessionId: string): string {
  return join(lanternDir, 'hooks', sessionId);
}

/** Close a session that never started, and hand its ticket back to the queue. */
function failBeforeSpawn(
  db: Database.Database,
  agent: Agent,
  sessionId: string,
  ticketId: number | null,
  pulseId: number,
  reason: string,
): void {
  updateSession(db, sessionId, {
    status: 'failed',
    result: reason.slice(0, 2000),
    endedAt: new Date().toISOString(),
  });
  if (ticketId === null) return;
  const ctx = { actor: agent.id, pulse_id: pulseId, session_id: sessionId };
  writeEvent(db, { ...ctx, ticket_id: ticketId, event: 'error', payload: { reason } });
  updateTicket(db, ticketId, { status: 'open' }, ctx);
}

/**
 * Reap-time check for a running session. Its completion is already awaited
 * from spawn, so the only thing left to catch is a handle that did not survive
 * a daemon restart.
 */
async function pollSession(
  db: Database.Database,
  agent: Agent,
  sessionId: string,
  lanternDir: string,
  live: LiveSessions,
): Promise<void> {
  if (live.handles.has(sessionId)) return;

  // The daemon that spawned this child is gone, so nothing will record its
  // result. Stop it rather than let it spend unaccounted, and hand the ticket
  // back — never leave a ticket stuck in `staffed`.
  const row = db.prepare('SELECT pid, ticket_id FROM sessions WHERE id = ?').get(sessionId) as
    | { pid: number | null; ticket_id: number | null }
    | undefined;
  const reason = 'handle lost across daemon restart';
  const killed =
    row?.pid != null && killIfOurs(row.pid, join(lanternDir, 'mcp', `session-${sessionId}.json`));
  updateSession(db, sessionId, {
    status: 'failed',
    result: killed ? `${reason}; child pid ${row?.pid} sent SIGTERM` : reason,
    endedAt: new Date().toISOString(),
  });
  if (row?.ticket_id == null) return;
  const ctx = { actor: agent.id, session_id: sessionId };
  writeEvent(db, { ...ctx, ticket_id: row.ticket_id, event: 'error', payload: { reason } });
  updateTicket(db, row.ticket_id, { status: 'open' }, ctx);
}

/**
 * SIGTERM `pid` only if its command line names this session's MCP config —
 * after a restart a stored pid may have been reused by an unrelated process.
 */
function killIfOurs(pid: number, marker: string): boolean {
  try {
    const cmd = execText('ps', ['-p', String(pid), '-o', 'command=']);
    if (!cmd.includes(marker)) return false;
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false; // no such process
  }
}

async function recordCompletion(
  db: Database.Database,
  agent: Agent,
  sessionId: string,
  entry: LiveEntry,
  lanternDir: string,
  dailyCeilingUsd: number,
  live: LiveSessions,
): Promise<void> {
  try {
    const state = await entry.harness.poll(entry.handleId);
    live.handles.delete(sessionId);

    // What conforms is kept; anything else falls back to free text.
    const structured = parseChildResult(state.structured);
    const endedAt = new Date().toISOString();
    const finalStatus =
      state.status === 'done' ? 'done' : state.status === 'timeout' ? 'timeout' : 'failed';

    updateSession(db, sessionId, {
      status: finalStatus,
      costUsd: state.costUsd,
      numTurns: state.numTurns,
      result: state.result.slice(0, 2000),
      exitCode: state.isError ? 1 : 0,
      endedAt,
    });

    // usage_daily is updated per session close, not just per pulse —
    // children are where the money actually goes. Law 7 applies to their spend
    // as much as to the orchestrator's.
    recordDailyUsage(db, { costUsd: state.costUsd, sessions: 1 });
    enforceDailyCeiling(db, { agentId: agent.id, ceilingUsd: dailyCeilingUsd });

    const sessionRow = db
      .prepare('SELECT worktree, branch, ticket_id, tier FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { worktree: string | null; branch: string | null; ticket_id: number | null; tier: string }
      | undefined;

    // a finished write child's branch is pushed and, on GitHub
    // with gh, opened as a draft PR — before the worktree it lives in is
    // removed. The branch itself stays in the repo.
    let pr: ReturnType<typeof publishBranch> | null = null;
    const prTicket = sessionRow?.ticket_id ? getTicket(db, sessionRow.ticket_id) : undefined;
    if (finalStatus === 'done' && sessionRow?.worktree && sessionRow.branch && prTicket) {
      pr = publishBranch({
        worktree: sessionRow.worktree,
        branch: sessionRow.branch,
        title: `#${prTicket.id} ${oneLine(prTicket.title, 200)}`,
        body: `Opened by Lantern for ticket #${prTicket.id} (session ${sessionId}).\n\n${structured ? `${structured.summary}${structured.root_cause ? `\n\nRoot cause: ${structured.root_cause}` : ''}` : state.result.slice(0, 4000)}`,
        gitEnv: pushGuardEnv(pushGuardDir(lanternDir, sessionId)),
      });
    }
    // a release child's one tag follows its branch, through the same guard.
    let tagPush: ReturnType<typeof pushReleaseTag> | null = null;
    if (pr?.ok && sessionRow?.tier === 'release' && sessionRow.worktree) {
      tagPush = pushReleaseTag({
        worktree: sessionRow.worktree,
        gitEnv: pushGuardEnv(pushGuardDir(lanternDir, sessionId)),
      });
    }

    // Clean up worktree
    if (sessionRow?.worktree) {
      try {
        destroyWorktree(agent.workdir, sessionRow.worktree);
      } catch {
        // Worktree cleanup is best-effort
      }
    }
    rmSync(pushGuardDir(lanternDir, sessionId), { recursive: true, force: true });

    // the ticket's transition is decided in one pure function.
    const ticketId = sessionRow?.ticket_id;
    if (ticketId) {
      const branch = sessionRow?.branch ?? null;
      const decision = decideCompletion({
        finalStatus,
        outcome: structured?.outcome ?? null,
        branch,
        pr,
        tag: tagPush,
        reviewBase:
          pr?.ok && pr.kind === 'branch' ? (defaultBranch(agent.workdir) ?? 'main') : 'main',
      });
      const ctx = { actor: agent.id, session_id: sessionId };
      writeEvent(db, {
        ...ctx,
        ticket_id: ticketId,
        event: decision.sessionEvent,
        payload: {
          session_id: sessionId,
          cost_usd: state.costUsd,
          result: state.result.slice(0, 500),
          structured,
        },
      });
      // App. C: follow-ups are the child's voice — filed for triage, linked.
      for (const f of structured?.follow_up_tickets ?? []) {
        const id = createTicket(
          db,
          {
            kind: f.kind,
            title: f.title,
            body: f.body,
            origin: 'agent:child',
            needs_triage: true,
            agent_id: agent.id,
          },
          ctx,
        );
        createLink(db, {
          from_ticket: ticketId,
          to_ticket: id,
          rel: 'relates_to',
          note: `follow-up from session ${sessionId}`,
        });
      }
      for (const e of decision.events) {
        writeEvent(db, { ...ctx, ticket_id: ticketId, event: e.event, payload: e.payload });
      }
      updateTicket(db, ticketId, decision.patch, ctx);
    }
  } catch {
    // poll threw — mark session failed
    updateSession(db, sessionId, {
      status: 'failed',
      result: 'poll error',
      endedAt: new Date().toISOString(),
    });
    live.handles.delete(sessionId);
  }
}

/** Kill a specific session by id. Returns true if found and signaled. */
export function killSession(
  db: Database.Database,
  sessionId: string,
  actor: string,
  live: LiveSessions = processSessions,
): boolean {
  const entry = live.handles.get(sessionId);
  if (!entry) return false;

  entry.harness.kill(entry.handleId).catch(() => {});
  live.handles.delete(sessionId);

  updateSession(db, sessionId, {
    status: 'killed',
    endedAt: new Date().toISOString(),
  });

  const sessionRow = db.prepare('SELECT ticket_id FROM sessions WHERE id = ?').get(sessionId) as
    | { ticket_id: number | null }
    | undefined;
  if (sessionRow?.ticket_id) {
    writeEvent(db, {
      ticket_id: sessionRow.ticket_id,
      actor,
      event: 'killed',
      payload: { session_id: sessionId },
      session_id: sessionId,
    });
    updateTicket(db, sessionRow.ticket_id, { status: 'open' }, { actor, session_id: sessionId });
  }

  return true;
}
