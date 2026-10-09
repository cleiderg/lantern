import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { DEFAULT_DAILY_CEILING_USD } from './budget.ts';
import { git } from './git.ts';
import { getLiveChildrenCount, getReservedBudget, getRunningPulse } from './store/pulses.ts';
import { getDailySpend, utcDay } from './store/usage.ts';
import type { AgentState } from './types.ts';

export type GateResult = { ok: true } | { ok: false; reason: string };

// ── Individual gate checks ────────────────────────────────────────────────────

/** Gate 1: PAUSED file absent and agent state is 'running'. */
export function checkKillSwitch(lanternDir: string, agentState: AgentState): GateResult {
  if (existsSync(join(lanternDir, 'PAUSED'))) {
    return { ok: false, reason: 'PAUSED file present' };
  }
  if (agentState !== 'running') {
    return { ok: false, reason: `agent state is '${agentState}'` };
  }
  return { ok: true };
}

/**
 * Gate 2: Today's spend (actual + reserved for live sessions) is below the daily
 * ceiling. `additionalUsd` asks whether one more reservation still fits — the
 * reap phase uses it before each spawn.
 */
export function checkDailySpend(
  db: Database.Database,
  ceilingUsd: number,
  day?: string,
  agentId?: string,
  additionalUsd = 0,
): GateResult {
  const today = day ?? utcDay();
  const spent = getDailySpend(db, today);
  const reserved = (agentId ? getReservedBudget(db, agentId) : 0) + additionalUsd;
  const total = spent + reserved;
  if (total >= ceilingUsd) {
    const reservedNote = reserved > 0 ? ` + $${reserved.toFixed(2)} reserved` : '';
    return {
      ok: false,
      reason: `daily spend $${spent.toFixed(2)}${reservedNote} meets or exceeds ceiling $${ceilingUsd.toFixed(2)}`,
    };
  }
  return { ok: true };
}

/** Gate 3: Live child sessions are under max_children. */
export function checkLiveChildren(
  db: Database.Database,
  agentId: string,
  maxChildren: number,
): GateResult {
  const live = getLiveChildrenCount(db, agentId);
  if (live >= maxChildren) {
    return {
      ok: false,
      reason: `live children (${live}) meets or exceeds max_children (${maxChildren})`,
    };
  }
  return { ok: true };
}

/** Gate 4: Current time is outside any configured quiet-hour window. */
export function checkQuietHours(quietHours: Array<[string, string]>, now?: Date): GateResult {
  if (quietHours.length === 0) return { ok: true };
  const current = now ?? new Date();
  const hhmm = `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`;
  for (const [start, end] of quietHours) {
    if (inQuietRange(hhmm, start, end)) {
      return { ok: false, reason: `quiet hours active (${start}–${end})` };
    }
  }
  return { ok: true };
}

function inQuietRange(hhmm: string, start: string, end: string): boolean {
  if (start <= end) return hhmm >= start && hhmm < end;
  // wraps midnight
  return hhmm >= start || hhmm < end;
}

/**
 * Gate 5: Working tree of the target repo is clean, or allow_dirty is set.
 * execFn is injectable for tests — defaults to `git status --porcelain` (an
 * argument list, never a shell string).
 */
export function checkWorkingTree(
  workdir: string,
  allowDirty: boolean,
  execFn?: (args: string[], cwd: string) => string,
): GateResult {
  if (allowDirty) return { ok: true };
  try {
    const run = execFn ?? ((args, cwd) => git(cwd, args));
    const output = run(['status', '--porcelain'], workdir);
    if (output.trim() !== '') {
      return { ok: false, reason: 'working tree is dirty' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'could not check working tree' };
  }
}

/** Gate 6: No pulse is still running for this agent. */
export function checkNoPulseRunning(db: Database.Database, agentId: string): GateResult {
  const running = getRunningPulse(db, agentId);
  if (running) {
    return { ok: false, reason: `pulse ${running.id} is still running` };
  }
  return { ok: true };
}

// ── Combined runner ───────────────────────────────────────────────────────────

export type GatesConfig = {
  lanternDir: string;
  agentId: string;
  agentState: AgentState;
  agentWorkdir: string;
  agentMaxChildren: number;
  dailyCeilingUsd?: number;
  allowDirty?: boolean;
  quietHours?: Array<[string, string]>;
  /** Injectable for tests — replaces git subprocess call. */
  execFn?: (args: string[], cwd: string) => string;
  /** Injectable for tests — overrides current time for quiet-hours check. */
  now?: Date;
  /** Injectable for tests — overrides today's date string for spend check. */
  day?: string;
};

/** Run all six gates in order; stop and return on the first failure. */
export function runGates(db: Database.Database, config: GatesConfig): GateResult {
  const checks: Array<() => GateResult> = [
    () => checkKillSwitch(config.lanternDir, config.agentState),
    () =>
      checkDailySpend(
        db,
        config.dailyCeilingUsd ?? DEFAULT_DAILY_CEILING_USD,
        config.day,
        config.agentId,
      ),
    () => checkLiveChildren(db, config.agentId, config.agentMaxChildren),
    () => checkQuietHours(config.quietHours ?? [], config.now),
    () => checkWorkingTree(config.agentWorkdir, config.allowDirty ?? false, config.execFn),
    () => checkNoPulseRunning(db, config.agentId),
  ];

  for (const check of checks) {
    const result = check();
    if (!result.ok) return result;
  }
  return { ok: true };
}
