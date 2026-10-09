/**
 * Edit an agent's operational settings from the UI. Law 6 forbids a *session* from
 * changing its own budgets or permissions; this is the human, through the
 * token-guarded page, and only for settings that tune how often and how much —
 * never what a child may run or touch.
 *
 * The `.agent.md` stays the single source of truth. An edit is validated by
 * loading the result before anything is written, the old file is backed up,
 * the write is atomic (temp file + rename), every change is appended to
 * `<lanternDir>/logs/config-changes.log`, and the agent row is refreshed.
 * Increases in spend need explicit confirmation and stay under fixed caps.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getAgent, upsertAgentFromConfig } from './agent.ts';
import { type AgentConfig, loadAgentConfig, parseDuration } from './agent-config.ts';
import type { Db } from './db.ts';
import { formatDuration } from './format.ts';

export const EDITABLE = [
  'heartbeat',
  'max_children',
  'per_pulse_usd',
  'per_day_usd',
  'quiet_hours',
] as const;
type Editable = (typeof EDITABLE)[number];

/** Settings that decide what a child may run or touch: the file only. */
const FILE_ONLY = [
  'id',
  'workdir',
  'test_commands',
  'ci_watch',
  'log_sources',
  'inbox_source',
  'actions',
  'noise_allowlist',
  'allow_dirty',
  'mission',
  'display_name',
  'budget',
];

/** The most the page may set; above this, edit the file. */
export const PAGE_CAPS = {
  perPulseUsd: 5,
  perDayUsd: 50,
  maxChildren: 10,
  heartbeatMinSeconds: 60,
  heartbeatMaxSeconds: 24 * 3600,
};

export type ConfigPatch = Partial<{
  heartbeat: string;
  max_children: number;
  per_pulse_usd: number;
  per_day_usd: number;
  quiet_hours: Array<[string, string]>;
}>;

export type EditResult =
  | { ok: true; messages: string[]; restartNeeded: boolean }
  | { ok: false; error: string; needsConfirm?: boolean };

export type ConfigChange = {
  ts: string;
  agent: string;
  actor: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  backup: string;
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const flowPairs = (pairs: Array<[string, string]>) =>
  `[${pairs.map(([a, b]) => `["${a}", "${b}"]`).join(', ')}]`;

// ── the file edit: change values in place, keep everything else ──────────────

/** Replace `key: value` on a frontmatter line, keeping a trailing comment. */
function replaceValue(line: string, value: string): string {
  const m = /^(\s*[\w-]+:)(\s*)([^#]*?)(\s+#.*)?$/.exec(line);
  if (!m) return line;
  return `${m[1]} ${value}${m[4] ?? ''}`;
}

const indentOf = (l: string) => l.match(/^ */)?.[0].length ?? 0;

/**
 * Set top-level `heartbeat`, `max_children`, `quiet_hours` and the two keys
 * under `budget:` in an `.agent.md`. Other lines, comments and the body are
 * left exactly as they were; a missing key is added before the closing `---`.
 */
export function setFrontmatterValues(raw: string, patch: ConfigPatch): string {
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?[\s\S]*)$/.exec(raw);
  if (!fm) throw new Error('missing --- frontmatter block');
  const lines = (fm[2] as string).split('\n');

  const setTop = (key: string, value: string) => {
    const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (i < 0) {
      lines.push(`${key}: ${value}`);
      return;
    }
    lines[i] = replaceValue(lines[i] as string, value);
    // A block value (`key:` then indented lines) is replaced by the flow form.
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() !== '' && indentOf(lines[j] as string) > 0) j++;
    lines.splice(i + 1, j - i - 1);
  };

  const setBudget = (key: string, value: string) => {
    let b = lines.findIndex((l) => /^budget:/.test(l));
    if (b < 0) {
      lines.push('budget:');
      b = lines.length - 1;
    }
    let j = b + 1;
    while (j < lines.length && indentOf(lines[j] as string) > 0) {
      if (new RegExp(`^\\s+${key}:`).test(lines[j] as string)) {
        lines[j] = replaceValue(lines[j] as string, value);
        return;
      }
      j++;
    }
    lines.splice(b + 1, 0, `  ${key}: ${value}`);
  };

  if (patch.heartbeat !== undefined) setTop('heartbeat', patch.heartbeat);
  if (patch.max_children !== undefined) setTop('max_children', String(patch.max_children));
  if (patch.quiet_hours !== undefined) setTop('quiet_hours', flowPairs(patch.quiet_hours));
  if (patch.per_pulse_usd !== undefined) setBudget('per_pulse_usd', patch.per_pulse_usd.toFixed(2));
  if (patch.per_day_usd !== undefined) setBudget('per_day_usd', patch.per_day_usd.toFixed(2));
  return `${fm[1]}${lines.join('\n')}${fm[3]}`;
}

// ── validation ────────────────────────────────────────────────────────────────

function validate(raw: Record<string, unknown>): ConfigPatch | string {
  const patch: ConfigPatch = {};
  for (const [key, v] of Object.entries(raw)) {
    if (FILE_ONLY.includes(key)) {
      return `${key} is file-only — it decides what a child may run or touch; edit the .agent.md`;
    }
    if (!(EDITABLE as readonly string[]).includes(key)) return `unknown setting '${key}'`;
    switch (key as Editable) {
      case 'heartbeat': {
        let s: number;
        try {
          s = parseDuration(String(v));
        } catch {
          return `heartbeat must look like 30s, 15m or 1h, got '${String(v)}'`;
        }
        if (s < PAGE_CAPS.heartbeatMinSeconds || s > PAGE_CAPS.heartbeatMaxSeconds) {
          return 'heartbeat must be between 1m and 24h';
        }
        patch.heartbeat = String(v).trim();
        break;
      }
      case 'max_children':
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > PAGE_CAPS.maxChildren) {
          return `max_children must be a whole number from 1 to ${PAGE_CAPS.maxChildren}`;
        }
        patch.max_children = v as number;
        break;
      case 'per_pulse_usd':
      case 'per_day_usd': {
        const cap = key === 'per_pulse_usd' ? PAGE_CAPS.perPulseUsd : PAGE_CAPS.perDayUsd;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          return `${key} must be a positive amount`;
        }
        if (v > cap)
          return `${key} from the page is at most ${usd(cap)} — above that, edit the .agent.md`;
        patch[key as 'per_pulse_usd' | 'per_day_usd'] = Math.round(v * 100) / 100;
        break;
      }
      case 'quiet_hours': {
        const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
        const ok =
          Array.isArray(v) &&
          v.length <= 4 &&
          v.every(
            (p) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every((t) => typeof t === 'string' && hhmm.test(t)),
          );
        if (!ok) return 'quiet_hours must be a list of up to 4 ["HH:MM", "HH:MM"] pairs';
        patch.quiet_hours = v as Array<[string, string]>;
        break;
      }
    }
  }
  return patch;
}

/** What the patch changes against the current file, as {from, to}. */
function diff(
  cfg: AgentConfig,
  patch: ConfigPatch,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  if (patch.heartbeat !== undefined && parseDuration(patch.heartbeat) !== cfg.heartbeatSeconds) {
    out.heartbeat = { from: formatDuration(cfg.heartbeatSeconds), to: patch.heartbeat };
  }
  if (patch.max_children !== undefined && patch.max_children !== cfg.maxChildren) {
    out.max_children = { from: cfg.maxChildren, to: patch.max_children };
  }
  if (patch.per_pulse_usd !== undefined && patch.per_pulse_usd !== cfg.budget.perPulseUsd) {
    out.per_pulse_usd = { from: cfg.budget.perPulseUsd, to: patch.per_pulse_usd };
  }
  if (patch.per_day_usd !== undefined && patch.per_day_usd !== cfg.budget.perDayUsd) {
    out.per_day_usd = { from: cfg.budget.perDayUsd, to: patch.per_day_usd };
  }
  if (
    patch.quiet_hours !== undefined &&
    JSON.stringify(patch.quiet_hours) !== JSON.stringify(cfg.quietHours)
  ) {
    out.quiet_hours = { from: cfg.quietHours, to: patch.quiet_hours };
  }
  return out;
}

/** Changes that can raise spend: a bigger budget, more children, a faster heartbeat. */
function increases(changes: Record<string, { from: unknown; to: unknown }>): string[] {
  const out: string[] = [];
  for (const k of ['per_pulse_usd', 'per_day_usd'] as const) {
    const c = changes[k];
    if (c && (c.to as number) > (c.from as number)) {
      out.push(`${k} ${usd(c.from as number)} → ${usd(c.to as number)}`);
    }
  }
  const mc = changes.max_children;
  if (mc && (mc.to as number) > (mc.from as number)) out.push(`max_children ${mc.from} → ${mc.to}`);
  const hb = changes.heartbeat;
  if (hb && parseDuration(hb.to as string) < parseDuration(hb.from as string)) {
    out.push(`heartbeat ${hb.from} → ${hb.to} (more pulses a day)`);
  }
  return out;
}

const changesLog = (lanternDir: string) => join(lanternDir, 'logs', 'config-changes.log');

export function editAgentConfig(
  db: Db,
  lanternDir: string,
  agentId: string,
  raw: Record<string, unknown>,
  opts: { actor: string; confirm?: boolean; now?: Date },
): EditResult {
  const agent = getAgent(db, agentId);
  if (!agent) return { ok: false, error: `agent '${agentId}' not found` };
  if (!isAbsolute(agent.config_path) || !existsSync(agent.config_path)) {
    return { ok: false, error: `agent '${agentId}' has no .agent.md to edit — register one first` };
  }
  const patch = validate(raw);
  if (typeof patch === 'string') return { ok: false, error: patch };

  let current: AgentConfig;
  try {
    current = loadAgentConfig(agent.config_path);
  } catch (e) {
    return {
      ok: false,
      error: `the .agent.md does not load now — fix it first: ${(e as Error).message}`,
    };
  }
  const perPulse = patch.per_pulse_usd ?? current.budget.perPulseUsd;
  const perDay = patch.per_day_usd ?? current.budget.perDayUsd;
  if (perPulse > perDay) {
    return {
      ok: false,
      error: `per_pulse_usd (${usd(perPulse)}) cannot exceed per_day_usd (${usd(perDay)})`,
    };
  }
  const changes = diff(current, patch);
  if (Object.keys(changes).length === 0) return { ok: false, error: 'no change' };
  const up = increases(changes);
  if (up.length && !opts.confirm) {
    return { ok: false, needsConfirm: true, error: `confirmation required: ${up.join('; ')}` };
  }

  // Write next to the file, prove it loads as the same agent, then swap it in.
  const original = readFileSync(agent.config_path, 'utf8');
  const next = setFrontmatterValues(original, patch);
  const tmp = join(dirname(agent.config_path), `.${agentId}.agent.md.lantern-edit`);
  writeFileSync(tmp, next);
  try {
    const check = loadAgentConfig(tmp);
    if (check.id !== current.id) throw new Error('the edit changed the agent id');
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, error: `the edited file would not load: ${(e as Error).message}` };
  }
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupDir = join(lanternDir, 'config-backups');
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `${agentId}-${stamp}.agent.md`);
  copyFileSync(agent.config_path, backup);
  renameSync(tmp, agent.config_path);

  // The row carries heartbeat and max_children for the scheduler and gates.
  upsertAgentFromConfig(db, loadAgentConfig(agent.config_path), agent.config_path);
  mkdirSync(join(lanternDir, 'logs'), { recursive: true });
  const record: ConfigChange = {
    ts: now.toISOString(),
    agent: agentId,
    actor: opts.actor,
    changes,
    backup,
  };
  appendFileSync(changesLog(lanternDir), `${JSON.stringify(record)}\n`);

  const restartNeeded = 'heartbeat' in changes;
  const said = Object.entries(changes).map(([k, c]) =>
    k.endsWith('_usd')
      ? `${k} ${usd(c.from as number)} → ${usd(c.to as number)}`
      : `${k} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`.replace(/"/g, ''),
  );
  return {
    ok: true,
    restartNeeded,
    messages: [
      `${agent.display_name}: ${said.join('; ')}`,
      restartNeeded
        ? 'the new heartbeat takes effect when its daemon restarts (Stop, then Start); the rest on the next pulse'
        : 'takes effect on the next pulse',
    ],
  };
}

/** The recorded changes for one agent, newest first. */
export function configChanges(lanternDir: string, agentId: string, limit = 20): ConfigChange[] {
  const p = changesLog(lanternDir);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ConfigChange];
      } catch {
        return [];
      }
    })
    .filter((c) => c.agent === agentId)
    .reverse()
    .slice(0, limit);
}
