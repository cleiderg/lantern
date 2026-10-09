/**
 * One pulse: gates → pulse row → collect → digest → orchestrator turn
 * → reap. The daemon's tick and `lantern pulse --now` (the UI's "Pulse now") both
 * run exactly this, so a manual pulse can no longer be a lesser pulse — it
 * used to skip the collect phase and reap, and its scans then reported "no
 * source configured".
 *
 * The one deliberate difference: a manual pulse does not require
 * `agents.state = 'running'` — running a pulse without the daemon is its whole
 * point — but it still refuses a tripped agent (Law 7) and still
 * honours the PAUSED kill switch and every other gate.
 */

import { getAgent, upsertAgentFromConfig } from './agent.ts';
import { type RuntimeSettings, runtimeSettings } from './agent-config.ts';
import { runCiWatch } from './collectors/ci-watch.ts';
import { runCollectors } from './collectors/collect-phase.ts';
import type { Db } from './db.ts';
import { buildDigest } from './digest.ts';
import { runGates } from './gates.ts';
import { ClaudeCodeHarness } from './harness/claude-code.ts';
import { runOrchestratorTurn } from './harness/orchestrator.ts';
import { reapSessions } from './harness/session-runner.ts';
import type { HarnessAdapter } from './harness/types.ts';
import type { PulseWindow } from './scheduler.ts';
import {
  createRunningPulse,
  createSkippedPulse,
  finishPulse,
  writePulseFinding,
} from './store/pulses.ts';
import { turnNeeded } from './turn-needed.ts';
import type { Agent } from './types.ts';

export type PulseOutcome =
  | { kind: 'skipped'; pulseId: number; reason: string }
  | { kind: 'error'; pulseId: number; error: string }
  | { kind: 'ran'; pulseId: number; status: string; costUsd: number };

export async function runPulse(opts: {
  db: Db;
  lanternDir: string;
  agentId: string;
  window: PulseWindow;
  /** `lantern pulse --now`: skip only the "state must be running" part of gate 1. */
  manual?: boolean;
  /** The orchestrator turn's harness; tests inject a fake. */
  harness?: HarnessAdapter;
  /** Children's harness; defaults to a real one. */
  childHarness?: HarnessAdapter;
  log?: (msg: string) => void;
}): Promise<PulseOutcome> {
  const { db, lanternDir, agentId, window: w } = opts;
  const log = opts.log ?? (() => {});
  const skip = (reason: string): PulseOutcome => {
    log(`pulse skipped — ${reason}`);
    const pulseId = createSkippedPulse(db, {
      agentId,
      windowStart: w.window_start,
      windowEnd: w.window_end,
      reason,
    });
    return { kind: 'skipped', pulseId, reason };
  };

  // Re-read the row and its .agent.md every pulse: state can change
  // under a running daemon (a Law 7 trip), and config edits apply next time.
  // A vanished row reads as 'stopped' so the gate refuses rather than guesses.
  const row = getAgent(db, agentId);
  if (!row) return skip(`agent '${agentId}' not found`);
  let current: Agent = row;
  let settings: RuntimeSettings;
  try {
    settings = runtimeSettings(current);
    if (settings.config) current = upsertAgentFromConfig(db, settings.config, row.config_path);
  } catch (e) {
    return skip(`agent config: ${e instanceof Error ? e.message : String(e)}`);
  }

  const agentState = opts.manual && current.state !== 'tripped' ? 'running' : current.state;
  const gate = runGates(db, {
    lanternDir,
    agentId: current.id,
    agentState,
    agentWorkdir: current.workdir,
    agentMaxChildren: current.max_children,
    dailyCeilingUsd: settings.dailyCeilingUsd,
    quietHours: settings.quietHours,
    allowDirty: settings.allowDirty,
  });
  if (!gate.ok) return skip(gate.reason);

  log('gates passed — building digest');
  const pulseId = createRunningPulse(db, {
    agentId: current.id,
    windowStart: w.window_start,
    windowEnd: w.window_end,
  });

  let digest: string;
  try {
    // Collect phase: collectors run before the turn, so the
    // digest already reflects what they found.
    runCollectors(db, current, pulseId, w, {
      logSources: settings.logSources,
      noiseAllowlist: settings.noiseAllowlist,
      inboxPath: settings.inboxSource,
    });
    // ci.watch runs the agent's tests when due (async: a run takes minutes).
    if (settings.ciWatch) await runCiWatch(db, current, pulseId, settings.ciWatch, { lanternDir });
    digest = buildDigest(db, current, w, settings.dailyCeilingUsd, undefined, settings.config);
  } catch (e) {
    // Never leave a 'running' row behind: gate 6 would refuse every later pulse.
    const error = `collect phase failed: ${e instanceof Error ? e.message : String(e)}`;
    finishPulse(db, pulseId, { status: 'error', error, dailyCeilingUsd: settings.dailyCeilingUsd });
    log(`pulse ${pulseId} error — ${error}`);
    return { kind: 'error', pulseId, error };
  }

  // no Claude turn when nothing changed since the last one.
  const need = turnNeeded(db, current.id, pulseId, { manual: opts.manual });
  if (!need.turn) {
    writePulseFinding(db, {
      pulseId,
      actionKey: 'heartbeat.selfcheck',
      outcome: 'clean',
      detail: `daemon healthy; no turn — nothing new since pulse #${need.lastTurnPulse}`,
    });
    finishPulse(db, pulseId, {
      status: 'clean',
      summary: `no turn — nothing new since pulse #${need.lastTurnPulse}`,
      costUsd: 0,
      dailyCeilingUsd: settings.dailyCeilingUsd,
    });
    log(`pulse ${pulseId} clean — no turn (nothing new since pulse #${need.lastTurnPulse})`);
    await reapSessions(
      db,
      current,
      lanternDir,
      pulseId,
      opts.childHarness,
      settings.dailyCeilingUsd,
    );
    log(`pulse ${pulseId} reap complete`);
    return { kind: 'ran', pulseId, status: 'clean', costUsd: 0 };
  }

  const r = await runOrchestratorTurn({
    db,
    agent: current,
    pulseId,
    digest,
    lanternDir,
    harness: opts.harness ?? new ClaudeCodeHarness(),
    costCeilingUsd: settings.perPulseUsd,
    dailyCeilingUsd: settings.dailyCeilingUsd,
    config: settings.config,
  });
  log(`pulse ${pulseId} ${r.status} — cost=$${r.costUsd.toFixed(4)}`);

  // Reap phase: spawn queued sessions and poll running ones.
  await reapSessions(db, current, lanternDir, pulseId, opts.childHarness, settings.dailyCeilingUsd);
  log(`pulse ${pulseId} reap complete`);
  return { kind: 'ran', pulseId, status: r.status, costUsd: r.costUsd };
}
