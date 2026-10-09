import type Database from 'better-sqlite3';

// ── Clock abstraction (injectable for tests) ──────────────────────────────────

export type Clock = {
  now(): number; // ms since epoch
  schedule(fn: () => void, delayMs: number): void;
};

// ── Pure scheduling math ──────────────────────────────────────────────────────

/** Returns heartbeatMs ± up to 10% random jitter. */
export function applyJitter(heartbeatMs: number, rng: () => number = Math.random): number {
  const variance = heartbeatMs * 0.1;
  return Math.round(heartbeatMs + (rng() * 2 - 1) * variance);
}

export type PulseWindow = {
  window_start: string; // ISO
  window_end: string; // ISO
};

/** How far back an agent's very first window looks. */
export const FIRST_WINDOW_LOOKBACK_MS = 24 * 3600 * 1000;
/** How soon after start the first pulse comes, when none is recent. */
export const START_DELAY_MS = 5_000;

/**
 * Computes the observation window for the next pulse.
 * window_start = end of last successful pulse's window. With no prior pulse it
 * looks back 24 h — it used to start at 1970, so the first scan of a real
 * app's logs would ticket months of history.
 * Callers must not pass `now` < `lastWindowEnd`.
 */
export function computeWindow(lastWindowEnd: string | null, nowIso: string): PulseWindow {
  return {
    window_start:
      lastWindowEnd ?? new Date(Date.parse(nowIso) - FIRST_WINDOW_LOOKBACK_MS).toISOString(),
    window_end: nowIso,
  };
}

/** Returns window_end of the last successful pulse for an agent, or null. */
export function getLastPulseWindowEnd(db: Database.Database, agentId: string): string | null {
  const row = db
    .prepare(
      `SELECT window_end FROM pulses
       WHERE agent_id = ? AND status IN ('clean','acted','escalated')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(agentId) as { window_end: string } | undefined;
  return row?.window_end ?? null;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export type SchedulerOpts = {
  heartbeatMs: number;
  clock: Clock;
  /** Called once per tick with the observation window. */
  onFire: (window: PulseWindow) => void;
  /** Returns the window_end of the last successful pulse, or null. */
  getLastWindowEnd: () => string | null;
  rng?: () => number;
};

export class Scheduler {
  private readonly heartbeatMs: number;
  private readonly clock: Clock;
  private readonly onFire: (w: PulseWindow) => void;
  private readonly getLastWindowEnd: () => string | null;
  private readonly rng: () => number;

  constructor(opts: SchedulerOpts) {
    this.heartbeatMs = opts.heartbeatMs;
    this.clock = opts.clock;
    this.onFire = opts.onFire;
    this.getLastWindowEnd = opts.getLastWindowEnd;
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * The first pulse comes when it is due: seconds after start if the last one
   * is a heartbeat old (or there is none), else when it becomes so. It used to
   * wait a full heartbeat after every start.
   */
  start(): void {
    const last = this.getLastWindowEnd();
    const lastMs = last ? Date.parse(last) : Number.NaN;
    const dueIn = Number.isNaN(lastMs) ? 0 : lastMs + this.heartbeatMs - this.clock.now();
    // Never later than one heartbeat: a 1 s test heartbeat still ticks within 1 s.
    this.clock.schedule(
      () => this.tick(),
      Math.max(Math.min(START_DELAY_MS, this.heartbeatMs), dueIn),
    );
  }

  private scheduleNext(): void {
    const delay = applyJitter(this.heartbeatMs, this.rng);
    this.clock.schedule(() => this.tick(), delay);
  }

  private tick(): void {
    const nowIso = new Date(this.clock.now()).toISOString();
    const window = computeWindow(this.getLastWindowEnd(), nowIso);
    this.onFire(window);
    this.scheduleNext();
  }
}
