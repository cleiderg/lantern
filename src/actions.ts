/**
 * The human surface of Lantern, shared by the CLI and `lantern ui`.
 *
 * Every action a person can take — answer or approve an escalation, accept or
 * dismiss a triage ticket, pause, resume, kill a child — lives here once, so
 * the terminal and the page cannot drift apart on what "approve" or "pause"
 * means. Callers own the transport: argv parsing and usage text for the CLI,
 * JSON for the UI. Each action validates its own input and returns a result;
 * none throws for a bad request.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent, listAgents, setAgentState, upsertAgentFromConfig } from './agent.ts';
import { loadAgentConfig } from './agent-config.ts';
import { startRefusal } from './daemon.ts';
import { daemonLogPath } from './daemon-log.ts';
import type { Db } from './db.ts';
import { killSession } from './harness/session-runner.ts';
import { answerEscalation } from './store/escalations.ts';
import { writeEvent } from './store/events.ts';
import { getLiveSessions, getSession, updateSession } from './store/sessions.ts';
import { getTicket, reopenTicket, updateTicket } from './store/tickets.ts';
import { acceptTicket, closeAs } from './ticket-policy.ts';
import type { EscalationVerdict, TerminalTicketStatus, TicketPriority } from './types.ts';
import { isLiveSession, isTerminalTicket } from './types.ts';

export type ActionResult = { ok: true; messages: string[] } | { ok: false; error: string };

const done = (...messages: string[]): ActionResult => ({ ok: true, messages });
const refuse = (error: string): ActionResult => ({ ok: false, error });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function badId(id: number): ActionResult | null {
  return Number.isInteger(id) && id > 0 ? null : refuse(`invalid id '${id}'`);
}

// ── Triage ─────────────────────────────────────────────────────────

export function triageAccept(db: Db, id: number): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  const refusal = acceptTicket(db, id);
  if (refusal) return refuse(refusal);
  return done(`ticket #${id} accepted — cleared needs_triage, open for staffing`);
}

/** Close as wontfix; closeTicket suppresses the fingerprint. */
export function triageDismiss(db: Db, id: number, reason: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (!reason.trim()) return refuse('a reason is required');
  const refusal = closeAs(db, 'human', id, 'wontfix', reason, { actor: 'human' });
  if (refusal) return refuse(refusal);
  return done(`ticket #${id} dismissed as wontfix`);
}

// ── Ticket workspace ──────────────────────────────────────────────

const PRIORITIES: readonly TicketPriority[] = ['p0', 'p1', 'p2', 'p3'];

export function ticketComment(db: Db, id: number, body: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (!body.trim()) return refuse('a comment cannot be empty');
  if (!getTicket(db, id)) return refuse(`#${id} not found`);
  writeEvent(db, {
    actor: 'human',
    ticket_id: id,
    event: 'commented',
    payload: { body: body.trim() },
  });
  return done(`comment added to #${id}`);
}

export function ticketPriority(db: Db, id: number, priority: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    return refuse(`priority must be one of ${PRIORITIES.join(', ')}`);
  }
  const t = getTicket(db, id);
  if (!t) return refuse(`#${id} not found`);
  if (t.priority === priority) return refuse(`#${id} is already ${priority}`);
  updateTicket(db, id, { priority: priority as TicketPriority }, { actor: 'human' });
  return done(`#${id} priority ${t.priority} → ${priority}`);
}

/** Close, wontfix or duplicate — with a resolution; the rules are ticket-policy's. */
export function ticketClose(db: Db, id: number, status: string, resolution: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  const refusal = closeAs(db, 'human', id, status as TerminalTicketStatus, resolution, {
    actor: 'human',
  });
  if (refusal) return refuse(refusal);
  return done(`#${id} ${status}`);
}

export function ticketReopen(db: Db, id: number, reason: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (!reason.trim()) return refuse('a reason is required to reopen');
  const t = getTicket(db, id);
  if (!t) return refuse(`#${id} not found`);
  if (!isTerminalTicket(t.status)) return refuse(`#${id} is already open (${t.status})`);
  reopenTicket(db, id, reason, { actor: 'human' });
  return done(`#${id} reopened`);
}

// ── Inbox ───────────────────────────────────────────────────

/** A plain reply: unblocks a blocking escalation, never approves a release. */
export function inboxAnswer(db: Db, id: number, text: string): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (!text.trim()) return refuse('an answer is required');
  try {
    answerEscalation(db, id, text, 'human');
  } catch (e) {
    return refuse(errText(e));
  }
  return done(`escalation #${id} answered`);
}

/** Approve or reject. An approve verdict is the only thing that lets a release start. */
export function inboxVerdict(
  db: Db,
  id: number,
  verdict: EscalationVerdict,
  text = '',
): ActionResult {
  const bad = badId(id);
  if (bad) return bad;
  if (verdict === 'reject' && !text.trim()) return refuse('a reason is required to reject');
  try {
    answerEscalation(db, id, text.trim() || 'approved', 'human', verdict);
  } catch (e) {
    return refuse(errText(e));
  }
  return done(`escalation #${id} ${verdict === 'approve' ? 'approved' : 'rejected'}`);
}

// ── Kill switch ───────────────────────────────────────────────────────────────

/** Stop one live session: in-process handle if this process has it, else its pid. */
function stopSession(db: Db, id: string, pid: number | null, actor: string): void {
  if (killSession(db, id, actor)) return;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // pid may already be gone
    }
  }
  updateSession(db, id, { status: 'killed', endedAt: new Date().toISOString() });
}

/** Write the PAUSED file and kill every agent's live children. */
export function pause(db: Db, lanternDir: string): ActionResult {
  writeFileSync(join(lanternDir, 'PAUSED'), '');
  const live = listAgents(db).flatMap((a) => getLiveSessions(db, a.id));
  for (const s of live) stopSession(db, s.id, s.pid, 'lantern-pause');
  const note = live.length > 0 ? ` (killed ${live.length} session(s))` : '';
  return done(`daemon paused — pulses blocked until \`lantern resume\`${note}`);
}

/**
 * Clear the PAUSED file and untrip budget-tripped agents (Law 7). Paused
 * or stopped agents were stopped on purpose and stay that way.
 */
export function resume(db: Db, lanternDir: string): ActionResult {
  const pausedPath = join(lanternDir, 'PAUSED');
  const wasPaused = existsSync(pausedPath);
  if (wasPaused) unlinkSync(pausedPath);
  const cleared: string[] = [];
  for (const agent of listAgents(db)) {
    if (agent.state !== 'tripped') continue;
    setAgentState(db, agent.id, 'running', null);
    cleared.push(
      `agent ${agent.id} (was tripped${agent.paused_reason ? `: ${agent.paused_reason}` : ''}) → running`,
    );
  }
  const messages = wasPaused ? ['kill switch cleared — pulses re-enabled'] : [];
  if (!wasPaused && cleared.length === 0) messages.push('nothing to resume');
  return done(...messages, ...cleared);
}

export function killSessionAction(db: Db, sessionId: string): ActionResult {
  const session = getSession(db, sessionId);
  if (!session) return refuse(`session '${sessionId}' not found`);
  if (!isLiveSession(session.status)) {
    return refuse(`session ${sessionId} is already ${session.status}`);
  }
  stopSession(db, sessionId, session.pid, 'human');
  return done(`session ${sessionId} killed`);
}

// ── Running Lantern ───────────────────────────────────────────────────

/**
 * Starts a detached `lantern <args>` process and returns its pid. Injectable so
 * tests never launch a real daemon or a real `claude` turn.
 */
export type Launcher = (args: string[], lanternDir: string) => number | undefined;

const LANTERN_BIN = fileURLToPath(new URL('../bin/lantern', import.meta.url));

export const launchDetached: Launcher = (args, lanternDir) => {
  const child = spawn(process.execPath, [LANTERN_BIN, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, LANTERN_DIR: lanternDir },
  });
  child.unref();
  return child.pid;
};

/** An agent is running while its PID file names a live process. */
export function agentRunning(
  lanternDir: string,
  agentId: string,
): { running: boolean; pid: number | null } {
  const pidPath = join(lanternDir, `${agentId}.pid`);
  if (!existsSync(pidPath)) return { running: false, pid: null };
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isInteger(pid)) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (e) {
    // EPERM: alive but not ours to signal — still running.
    return { running: (e as NodeJS.ErrnoException).code === 'EPERM', pid };
  }
}

/** `lantern start --agent <id> --daemon`. Refuses a tripped agent and a running one. */
export function startAgent(
  db: Db,
  lanternDir: string,
  agentId: string,
  launch: Launcher = launchDetached,
): ActionResult {
  const agent = getAgent(db, agentId);
  if (!agent) return refuse(`agent '${agentId}' not found`);
  const refusal = startRefusal(agent);
  if (refusal) return refuse(refusal);
  const { running, pid } = agentRunning(lanternDir, agentId);
  if (running) return refuse(`agent ${agentId} is already running (pid ${pid})`);
  const child = launch(['start', '--agent', agentId], lanternDir);
  return done(`agent ${agentId} starting (pid ${child}), logging to ${daemonLogPath(lanternDir)}`);
}

/** `lantern stop --agent <id>`: SIGTERM the PID file's process, remove the file, mark paused. */
export function stopAgent(db: Db, lanternDir: string, agentId: string): ActionResult {
  const agent = getAgent(db, agentId);
  if (!agent) return refuse(`agent '${agentId}' not found`);
  const pidPath = join(lanternDir, `${agent.id}.pid`);
  let message: string;
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      message = `sent SIGTERM to ${agent.display_name} daemon (pid ${pid})`;
    } catch {
      message = `pid ${pid} not found — daemon already gone`;
    }
    unlinkSync(pidPath);
  } else {
    message = `no running daemon found for agent '${agent.id}'`;
  }
  setAgentState(db, agent.id, 'paused');
  return done(message);
}

/** `lantern agent add <path>`. The path must be absolute; the CLI resolves it first. */
export function registerAgent(db: Db, configPath: string): ActionResult {
  if (!isAbsolute(configPath)) return refuse(`config path must be absolute, got '${configPath}'`);
  try {
    const a = upsertAgentFromConfig(db, loadAgentConfig(configPath), configPath);
    return done(
      `agent ${a.id} registered from ${configPath} — heartbeat=${a.heartbeat_seconds}s ` +
        `max_children=${a.max_children} workdir=${a.workdir} [${a.state}]`,
    );
  } catch (e) {
    return refuse(errText(e));
  }
}

/** `lantern pulse --now --agent <id>`, in its own process: a turn takes minutes. */
export function pulseNow(
  db: Db,
  lanternDir: string,
  agentId: string,
  launch: Launcher = launchDetached,
): ActionResult {
  const agent = getAgent(db, agentId);
  if (!agent) return refuse(`agent '${agentId}' not found`);
  const refusal = startRefusal(agent);
  if (refusal) return refuse(refusal);
  const pid = launch(['pulse', '--now', '--agent', agentId], lanternDir);
  return done(`pulse for ${agentId} started (pid ${pid}) — see Pulses`);
}
