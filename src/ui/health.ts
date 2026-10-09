/**
 * Agent health that explains itself: gate refusals in plain words
 * with their fix, and today's spend with a projected trip time. Pure functions —
 * the API feeds them rows, the tests feed them fixtures.
 */

export type Explanation = { plain: string; fix: string };

const RULES: Array<[RegExp, (m: RegExpExecArray) => Explanation]> = [
  [
    /^PAUSED file present$/,
    () => ({
      plain: 'The kill switch is on, so no agent pulses.',
      fix: 'Press Resume (or run `lantern resume`).',
    }),
  ],
  [
    /^agent state is 'tripped'$/,
    () => ({
      plain: 'The daily budget tripped this agent.',
      fix: 'Press Resume once you are happy with the spend (or raise per_day_usd and re-register).',
    }),
  ],
  [
    /^agent state is '(\w+)'$/,
    (m) => ({
      plain: `The agent is ${m[1]} — its daemon is not running.`,
      fix: 'Press Start on its card.',
    }),
  ],
  [
    /^daily spend \$([\d.]+)(?: \+ \$([\d.]+) reserved)? meets or exceeds ceiling \$([\d.]+)$/,
    (m) => ({
      plain: `Today's spend $${m[1]}${m[2] ? ` including $${m[2]} reserved for children still running` : ''} has reached the $${m[3]} daily ceiling.`,
      fix: m[2]
        ? 'Wait for running children to finish, raise per_day_usd, or wait for UTC midnight.'
        : 'Raise per_day_usd in the .agent.md and re-register, or wait for UTC midnight.',
    }),
  ],
  [
    /^live children \((\d+)\) meets or exceeds max_children \((\d+)\)$/,
    (m) => ({
      plain: `${m[1]} child session(s) are running, the most this agent may have (${m[2]}).`,
      fix: 'Wait for one to finish, kill one in Sessions, or raise max_children.',
    }),
  ],
  [
    /^quiet hours active \((.+)\)$/,
    (m) => ({
      plain: `Quiet hours (${m[1]}) are in effect.`,
      fix: 'Wait them out, or change quiet_hours in the .agent.md.',
    }),
  ],
  [
    /^working tree is dirty$/,
    () => ({
      plain: "The agent's repo has uncommitted changes, so pulses wait for a clean tree.",
      fix: 'Commit or stash them in the workdir, or set allow_dirty: true.',
    }),
  ],
  [
    /^could not check working tree$/,
    () => ({
      plain:
        "Git could not read the agent's workdir — it may not be a git repo, or may be missing.",
      fix: 'Point workdir at a git checkout, or set allow_dirty: true.',
    }),
  ],
  [
    /^pulse (\d+) is still running$/,
    (m) => ({
      plain: `Pulse #${m[1]} has not finished yet; pulses never overlap.`,
      fix: 'Wait for it to finish.',
    }),
  ],
  [
    /^agent config: (.*)$/s,
    (m) => ({
      plain: `The agent's config could not be read: ${m[1]}`,
      fix: 'Fix the .agent.md, then Register it again.',
    }),
  ],
];

/**
 * Every reason `runPulse` can skip with (src/gates.ts, src/pulse.ts), in plain
 * words. An unrecognised reason is shown as-is — never hidden behind a guess.
 */
export function explainSkip(reason: string): Explanation {
  for (const [re, explain] of RULES) {
    const m = re.exec(reason);
    if (m) return explain(m);
  }
  return { plain: reason, fix: '' };
}

export type SpendProjection = {
  spentUsd: number;
  ceilingUsd: number;
  /** Spend per UTC hour today, 24 entries. */
  series: number[];
  /** Burn over the last 3 hours (or since the first spend today, if later). */
  ratePerHour: number;
  /** When spend would reach the ceiling at that rate, if before UTC midnight. */
  tripAt: string | null;
  tripped: boolean;
};

const WINDOW_HOURS = 3;

/** Today's (UTC) spend by hour and when the ceiling would trip at the recent rate. */
export function projectSpend(opts: {
  costs: Array<{ at: string; usd: number }>;
  ceilingUsd: number;
  now: Date;
}): SpendProjection {
  const now = opts.now.getTime();
  const dayStart = Date.UTC(
    opts.now.getUTCFullYear(),
    opts.now.getUTCMonth(),
    opts.now.getUTCDate(),
  );
  const series = new Array<number>(24).fill(0);
  let spent = 0;
  let recent = 0;
  let first: number | null = null;
  const windowStart = now - WINDOW_HOURS * 3_600_000;
  for (const c of opts.costs) {
    const t = Date.parse(c.at);
    if (Number.isNaN(t) || t < dayStart || t > now || !(c.usd > 0)) continue;
    const hour = new Date(t).getUTCHours();
    series[hour] = (series[hour] ?? 0) + c.usd;
    spent += c.usd;
    if (t >= windowStart) recent += c.usd;
    first = first === null ? t : Math.min(first, t);
  }
  // Rate over the last 3 h — or since the first spend, if the day started later.
  const span =
    first === null
      ? 0
      : Math.max(1, (now - Math.max(windowStart, Math.min(first, now))) / 3_600_000);
  const hours = first === null ? 0 : Math.min(WINDOW_HOURS, span);
  const ratePerHour = hours > 0 ? recent / hours : 0;
  const tripped = spent >= opts.ceilingUsd;
  let tripAt: string | null = null;
  if (!tripped && ratePerHour > 0) {
    const t = now + ((opts.ceilingUsd - spent) / ratePerHour) * 3_600_000;
    if (t < dayStart + 86_400_000) tripAt = new Date(Math.round(t / 60_000) * 60_000).toISOString();
  }
  return { spentUsd: spent, ceilingUsd: opts.ceilingUsd, series, ratePerHour, tripAt, tripped };
}
