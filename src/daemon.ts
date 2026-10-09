import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureDefaultAgent,
  getAgent,
  setAgentNextPulse,
  setAgentState,
  transitionAgentState,
} from './agent.ts';
import { createDaemonLogger } from './daemon-log.ts';
import { openDb } from './db.ts';
import { checkDeadMan } from './deadman.ts';
import { notify as defaultNotify } from './notify.ts';
import { runPulse } from './pulse.ts';
import { getLastPulseWindowEnd, Scheduler } from './scheduler.ts';
import { recoverOrphanedPulses } from './store/pulses.ts';
import type { Agent } from './types.ts';

export function startDaemon(
  lanternDir: string,
  agentId?: string,
  notifyFn: typeof defaultNotify = defaultNotify,
): void {
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = agentId
    ? (getAgent(db, agentId) ?? ensureDefaultAgent(db, lanternDir))
    : ensureDefaultAgent(db, lanternDir);
  // Law 7: a budget trip needs an explicit `lantern resume`. Starting the daemon
  // used to overwrite it with 'running'.
  const refusal = startRefusal(agent);
  if (refusal) {
    db.close();
    throw new Error(refusal);
  }
  setAgentState(db, agent.id, 'running');
  // `agent` is a startup snapshot: fine for identity and heartbeat, never for
  // state. onFire re-reads the row each tick, because state changes under a
  // running daemon — a Law 7 trip from enforceDailyCeiling most of all.
  agent.state = 'running';

  // JSON lines in <lanternDir>/logs/lanternd.log, rotated daily.
  const log = createDaemonLogger(lanternDir, agent.id);

  // Signal handlers go in before anything announces this process — the PID
  // file `lantern stop` reads, or the log line tests wait on. A SIGTERM landing
  // earlier got Node's default: exit without marking the agent stopped or
  // removing the PID file.
  const pidPath = join(lanternDir, `${agent.id}.pid`);
  const shutdown = (sig: string) => {
    log(`lantern daemon stopping — signal=${sig} agent=${agent.id}`);
    try {
      transitionAgentState(db, agent.id, 'running', 'stopped');
    } catch {
      /* best-effort */
    }
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const recovered = recoverOrphanedPulses(db, agent.id);
  if (recovered > 0) {
    log(`recovered ${recovered} orphaned pulse(s) from previous crash`);
  }

  // Dead-man alert: warn if this agent went silent for 3x its
  // heartbeat before this start (e.g. the machine was asleep, or the daemon
  // crashed and stayed down). Checked once at startup, not every tick —
  // the scheduler keeps last_pulse_at fresh from here on.
  const deadman = checkDeadMan(agent, Date.now());
  if (deadman.stale) {
    log(
      `⚠ dead-man check: no pulse since ${deadman.referenceAt} (${deadman.staleSeconds}s ago, ` +
        `threshold ${deadman.thresholdSeconds}s) — was the daemon down?`,
    );
    notifyFn(
      'Lantern: dead-man alert',
      `${agent.display_name} had no pulse for ${Math.round(deadman.staleSeconds / 60)}m before this start`,
    );
  }

  // Write PID file so `lantern stop` can find and terminate this daemon.
  writeFileSync(pidPath, String(process.pid));

  log(
    `lantern daemon started — agent="${agent.display_name}" id=${agent.id} heartbeat=${agent.heartbeat_seconds}s pid=${process.pid}`,
  );

  const scheduler = new Scheduler({
    heartbeatMs: agent.heartbeat_seconds * 1000,
    clock: {
      now: () => Date.now(),
      schedule: (fn, delayMs) => {
        const nextAt = new Date(Date.now() + delayMs).toISOString();
        setAgentNextPulse(db, agent.id, nextAt);
        setTimeout(fn, delayMs);
      },
    },
    onFire: (w) => {
      log(`tick: window ${w.window_start.slice(0, 19)} → ${w.window_end.slice(0, 19)}`);
      // The same pulse `lantern pulse --now` runs (src/pulse.ts); state, config
      // and gates are re-read inside, every tick.
      runPulse({ db, lanternDir, agentId: agent.id, window: w, log })
        .then((r) => {
          if (r.kind === 'ran' && r.status === 'escalated') {
            notifyFn(
              'Lantern: new escalation',
              `${agent.display_name} needs your input — run \`lantern inbox\``,
            );
          }
        })
        .catch((e: unknown) => {
          log(`pulse error — ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    getLastWindowEnd: () => getLastPulseWindowEnd(db, agent.id),
  });

  scheduler.start();
}

/** Why this agent must not be started, or null. Shared with `lantern start --daemon`'s pre-check. */
export function startRefusal(agent: Agent): string | null {
  if (agent.state !== 'tripped') return null;
  const why = agent.paused_reason ? ` (${agent.paused_reason})` : '';
  return `agent ${agent.id} is tripped${why} — run \`lantern resume\` first`;
}
