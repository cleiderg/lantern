import { parseStoredTime } from './time.ts';
import type { Agent } from './types.ts';

export type DeadManCheck = {
  stale: boolean;
  referenceAt: string;
  thresholdSeconds: number;
  staleSeconds: number;
};

/**
 * Dead-man alert: no pulse in 3x the heartbeat. Falls back to
 * `created_at` when the agent has never pulsed, so a brand-new agent doesn't
 * alert before its first heartbeat has even had a chance to fire.
 */
export function checkDeadMan(agent: Agent, nowMs: number, multiplier = 3): DeadManCheck {
  const referenceAt = agent.last_pulse_at ?? agent.created_at;
  const referenceMs = parseStoredTime(referenceAt);
  const thresholdSeconds = multiplier * agent.heartbeat_seconds;
  // An unreadable reference proves nothing about liveness. Report it stale:
  // NaN compares false, which is how this alert used to stay silent forever.
  if (Number.isNaN(referenceMs)) {
    return { stale: true, referenceAt, thresholdSeconds, staleSeconds: Number.POSITIVE_INFINITY };
  }
  const staleSeconds = Math.floor((nowMs - referenceMs) / 1000);
  return { stale: staleSeconds > thresholdSeconds, referenceAt, thresholdSeconds, staleSeconds };
}
