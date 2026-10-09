/**
 * Agent configuration: `agents/<id>.agent.md`, machine-read
 * frontmatter plus a markdown body that is prompt material.
 *
 * The frontmatter is parsed by a hand-written YAML **subset** — no dependency
 *. Supported: `key: scalar`, nested maps, block lists
 * of scalars or maps, flow lists (`[]`, `[["22:00", "07:00"]]`), `#` comments.
 * Anything else — anchors, block scalars, flow maps, tabs, duplicate keys — is
 * a named error with its line number, never a silent misread.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_DAILY_CEILING_USD, PER_SESSION_CEILING_USD } from './budget.ts';
import type { NoisePattern } from './collectors/types.ts';

export type LogSourceConfig = { path: string; format?: 'ndjson' | 'plain' };

export type AgentConfig = {
  id: string;
  displayName: string;
  heartbeatSeconds: number;
  maxChildren: number;
  workdir: string;
  mission: string;
  budget: { perPulseUsd: number; perDayUsd: number };
  quietHours: Array<[string, string]>;
  allowDirty: boolean;
  logSources: LogSourceConfig[];
  noiseAllowlist: NoisePattern[];
  /** commands the write tiers may run to test a fix, e.g. `./mvnw -q test`. */
  testCommands: string[];
  /** `ci.watch` — run one of testCommands on the default branch and read its JUnit reports. */
  ciWatch: CiWatchConfig | null;
  /** Bug-inbox JSON file, resolved against the config's dir; null when unset. */
  inboxSource: string | null;
  /** `actions:` — the every-pulse action keys, in order. */
  actions: Array<{ key: string; playbook: string }>;
  /** Markdown after the frontmatter — expertise, mission, actions, laws. */
  body: string;
};

export type CiWatchConfig = {
  /** One of the agent's test_commands, run from the repository root. */
  command: string;
  /** Report paths relative to the repo root; `*` only in the file name. */
  reports: string[];
  everySeconds: number;
  timeoutSeconds: number;
};

// ── YAML subset ───────────────────────────────────────────────────────────────

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };
type Line = { indent: number; text: string; no: number };

export function parseYamlSubset(src: string): { [k: string]: Yaml } {
  const lines: Line[] = [];
  src.split('\n').forEach((raw, i) => {
    const no = i + 1;
    const lead = raw.match(/^[ \t]*/)?.[0] ?? '';
    if (lead.includes('\t')) throw yamlError(no, 'tab in indentation (use spaces)');
    const text = stripComment(raw.slice(lead.length), no).trimEnd();
    if (text) lines.push({ indent: lead.length, text, no });
  });
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  if (next < lines.length) throw yamlError(lines[next]?.no ?? 0, 'unexpected indentation');
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw yamlError(1, 'frontmatter must be a map of keys');
  }
  return value;
}

function yamlError(line: number, msg: string): Error {
  return new Error(`agent config: line ${line}: ${msg}`);
}

/** Drop a `#` comment that is outside quotes and at the start or after whitespace. */
function stripComment(text: string, no: number): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i);
    }
  }
  if (quote) throw yamlError(no, 'unterminated quoted string');
  return text;
}

function parseBlock(lines: Line[], i: number, indent: number): [Yaml, number] {
  const first = lines[i];
  if (!first) return [null, i];
  return first.text === '-' || first.text.startsWith('- ')
    ? parseList(lines, i, indent)
    : parseMap(lines, i, indent);
}

function parseMap(lines: Line[], i: number, indent: number): [Yaml, number] {
  const out: { [k: string]: Yaml } = {};
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw yamlError(line.no, 'unexpected indentation');
    if (line.text.startsWith('- ')) throw yamlError(line.no, 'list item where a key was expected');
    const m = line.text.match(/^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/);
    if (!m) throw yamlError(line.no, `expected 'key: value', got '${line.text}'`);
    const key = m[1] as string;
    if (key in out) throw yamlError(line.no, `duplicate key '${key}'`);
    const rest = m[2]?.trim() ?? '';
    i++;
    if (rest) {
      out[key] = parseScalar(rest, line.no);
    } else if (i < lines.length && (lines[i] as Line).indent > indent) {
      [out[key], i] = parseBlock(lines, i, (lines[i] as Line).indent);
    } else if (
      i < lines.length &&
      (lines[i] as Line).text.startsWith('- ') &&
      (lines[i] as Line).indent === indent
    ) {
      // `key:` followed by a list at the same indent (common YAML style)
      [out[key], i] = parseList(lines, i, indent);
    } else {
      out[key] = null;
    }
  }
  return [out, i];
}

function parseList(lines: Line[], i: number, indent: number): [Yaml, number] {
  const out: Yaml[] = [];
  while (i < lines.length) {
    const line = lines[i] as Line;
    if (line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) {
      if (line.indent > indent) throw yamlError(line.no, 'unexpected indentation');
      break;
    }
    const item = line.text.slice(1).trim();
    if (/^[A-Za-z_][\w.-]*:(\s|$)/.test(item)) {
      // `- key: v` starts a map whose keys sit two columns in.
      const inner = indent + 2;
      lines[i] = { indent: inner, text: item, no: line.no };
      const [map, next] = parseMap(lines, i, inner);
      out.push(map);
      i = next;
    } else if (item) {
      out.push(parseScalar(item, line.no));
      i++;
    } else {
      throw yamlError(line.no, 'empty list item');
    }
  }
  return [out, i];
}

function parseScalar(text: string, no: number): Yaml {
  const c = text[0];
  if (c === '&' || c === '*') throw yamlError(no, 'anchors and aliases are not supported');
  if (c === '|' || c === '>') throw yamlError(no, 'block scalars are not supported');
  if (c === '!') throw yamlError(no, 'tags are not supported');
  if (c === '{') throw yamlError(no, 'flow maps are not supported');
  if (c === '[') {
    const [value, end] = parseFlowList(text, 0, no);
    if (text.slice(end).trim())
      throw yamlError(no, `unexpected text after list: '${text.slice(end)}'`);
    return value;
  }
  if (c === '"') {
    try {
      return JSON.parse(text) as string;
    } catch {
      throw yamlError(no, `bad double-quoted string: ${text}`);
    }
  }
  if (c === "'") {
    if (!text.endsWith("'") || text.length < 2)
      throw yamlError(no, `bad single-quoted string: ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** `[a, "b", [c]]` starting at text[at] === '['. Returns the list and the index after `]`. */
function parseFlowList(text: string, at: number, no: number): [Yaml[], number] {
  const out: Yaml[] = [];
  let i = at + 1;
  const skip = () => {
    while (text[i] === ' ') i++;
  };
  skip();
  if (text[i] === ']') return [out, i + 1];
  while (i < text.length) {
    skip();
    if (text[i] === '[') {
      const [inner, next] = parseFlowList(text, i, no);
      out.push(inner);
      i = next;
    } else {
      let j = i;
      if (text[i] === '"' || text[i] === "'") {
        const q = text[i];
        j = i + 1;
        while (j < text.length && text[j] !== q) j += text[j] === '\\' && q === '"' ? 2 : 1;
        j++;
      } else {
        while (j < text.length && text[j] !== ',' && text[j] !== ']') j++;
      }
      out.push(parseScalar(text.slice(i, j).trim(), no));
      i = j;
    }
    skip();
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === ']') return [out, i + 1];
    throw yamlError(no, `expected ',' or ']' in flow list`);
  }
  throw yamlError(no, 'unterminated flow list');
}

// ── Agent config ──────────────────────────────────────────────────────────────

/** `30s`, `2m`, `60m`, `1h` → seconds. */
export function parseDuration(v: string): number {
  const m = /^(\d+)\s*([smh])$/.exec(v.trim());
  if (!m) throw new Error(`agent config: heartbeat must look like 30s, 15m or 1h, got '${v}'`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'];
}

export function loadAgentConfig(path: string): AgentConfig {
  const raw = readFileSync(path, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!fm) throw new Error(`agent config ${path}: missing '---' frontmatter block`);
  const y = parseYamlSubset(fm[1] as string);
  const body = fm[2] as string;
  const bad = (field: string, why: string) => new Error(`agent config ${path}: ${field} ${why}`);

  const id = y.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw bad('id', 'is required: lowercase letters, digits, - and _');
  }
  if (typeof y.workdir !== 'string' || !y.workdir) throw bad('workdir', 'is required');
  const workdir = y.workdir.startsWith('~') ? homedir() + y.workdir.slice(1) : y.workdir;
  if (!isAbsolute(workdir)) throw bad('workdir', `must be absolute, got '${y.workdir}'`);

  const maxChildren = y.max_children ?? 4;
  if (!Number.isInteger(maxChildren) || (maxChildren as number) < 1) {
    throw bad('max_children', 'must be a positive integer');
  }

  const budgetRaw = (y.budget ?? {}) as { [k: string]: Yaml };
  const usd = (key: string, dflt: number) => {
    const v = budgetRaw[key] ?? dflt;
    if (typeof v !== 'number' || !(v > 0)) throw bad(`budget.${key}`, 'must be a positive number');
    return v;
  };

  const quietRaw = y.quiet_hours ?? [];
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (
    !Array.isArray(quietRaw) ||
    !quietRaw.every(
      (p) =>
        Array.isArray(p) && p.length === 2 && p.every((t) => typeof t === 'string' && hhmm.test(t)),
    )
  ) {
    throw bad('quiet_hours', 'must be a list of ["HH:MM", "HH:MM"] pairs');
  }

  if (y.allow_dirty !== undefined && typeof y.allow_dirty !== 'boolean') {
    throw bad('allow_dirty', 'must be true or false');
  }

  const logSources = ((y.log_sources ?? []) as Yaml[]).map((s, n): LogSourceConfig => {
    const src = s as { [k: string]: Yaml };
    if (typeof src?.path !== 'string') throw bad(`log_sources[${n}].path`, 'is required');
    const format = src.format ?? undefined;
    if (format !== undefined && format !== 'ndjson' && format !== 'plain') {
      throw bad(`log_sources[${n}].format`, "must be 'ndjson' or 'plain'");
    }
    return {
      path: resolve(dirname(path), src.path),
      ...(format ? { format } : {}),
    };
  });

  const testCommands = parseTestCommands(y.test_commands, bad);
  const ciWatch = parseCiWatch(y.ci_watch, testCommands, bad);

  const noiseAllowlist = ((y.noise_allowlist ?? []) as Yaml[]).map((e, n): NoisePattern => {
    const entry = e as { [k: string]: Yaml };
    const source = entry?.source;
    if (source !== 'logs' && source !== 'inbox' && source !== 'email' && source !== 'ci') {
      throw bad(`noise_allowlist[${n}].source`, 'must be logs, inbox, email or ci');
    }
    if (typeof entry.pattern !== 'string')
      throw bad(`noise_allowlist[${n}].pattern`, 'is required');
    try {
      new RegExp(entry.pattern);
    } catch {
      throw bad(`noise_allowlist[${n}].pattern`, `is not a valid regex: ${entry.pattern}`);
    }
    return { source, pattern: entry.pattern };
  });

  if (y.inbox_source !== undefined && typeof y.inbox_source !== 'string') {
    throw bad('inbox_source', 'must be a path');
  }
  const inboxSource =
    typeof y.inbox_source === 'string' ? resolve(dirname(path), y.inbox_source) : null;

  const actions = ((y.actions ?? []) as Yaml[]).map((a, n) => {
    const entry = a as { [k: string]: Yaml };
    if (typeof entry?.key !== 'string') throw bad(`actions[${n}].key`, 'is required');
    return {
      key: entry.key,
      playbook: typeof entry.playbook === 'string' ? entry.playbook : entry.key,
    };
  });

  const mission = bodySection(body, 'Mission');
  if (!mission) throw bad('body', "needs a '## Mission' section");

  return {
    id,
    displayName: typeof y.display_name === 'string' ? y.display_name : id,
    heartbeatSeconds: y.heartbeat === undefined ? 3600 : parseDuration(String(y.heartbeat)),
    maxChildren: maxChildren as number,
    workdir,
    mission,
    budget: {
      perPulseUsd: usd('per_pulse_usd', PER_SESSION_CEILING_USD),
      perDayUsd: usd('per_day_usd', DEFAULT_DAILY_CEILING_USD),
    },
    quietHours: quietRaw as Array<[string, string]>,
    allowDirty: y.allow_dirty === true,
    logSources,
    noiseAllowlist,
    testCommands,
    ciWatch,
    inboxSource,
    actions,
    body,
  };
}

/**
 * The text under a `## <heading>` of the config body, up to the next `## `.
 * Matches on the heading's first word(s), so `## Expertise — how it reasons`
 * is found by 'Expertise'. Undefined when absent or empty.
 */
export function bodySection(body: string, heading: string): string | undefined {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^## ${esc}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'mi').exec(body);
  return m?.[1]?.trim() || undefined;
}

// ── What one pulse runs on ────────────────────────────────────────────────────

export type RuntimeSettings = {
  /** The parsed file, or null for an older row with no registered config. */
  config: AgentConfig | null;
  dailyCeilingUsd: number;
  perPulseUsd: number;
  quietHours: Array<[string, string]>;
  allowDirty: boolean;
  logSources: LogSourceConfig[];
  noiseAllowlist: NoisePattern[];
  testCommands: string[];
  ciWatch: CiWatchConfig | null;
  inboxSource: string | null;
};

/**
 * Resolve an agent's settings for this pulse. A row registered by
 * `lantern agent add` has an absolute `config_path` and is re-read every call,
 * so edits apply on the next tick; a broken file throws, and the caller skips
 * the pulse with that reason. A relative path is an older row: it runs on the defaults.
 */
/**
 * The commands a write child may run to test its fix. Each becomes
 * an exact `Bash(<cmd>)` / `Bash(<cmd> *)` allowlist entry, so it must be one
 * plain command: no shell metacharacters (a `;` or `&&` would chain anything
 * after it), no git (pushing is the daemon's, Law 1), at most five.
 */
const SHELL_META = /[;&|`$<>()\n\r\\]/;
const MAX_TEST_COMMANDS = 5;

function parseTestCommands(
  raw: Yaml | undefined,
  bad: (f: string, why: string) => Error,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad('test_commands', 'must be a list of commands');
  if (raw.length > MAX_TEST_COMMANDS) {
    throw bad('test_commands', `may name at most ${MAX_TEST_COMMANDS} commands`);
  }
  return raw.map((c, n) => {
    const cmd = typeof c === 'string' ? c.trim() : '';
    if (!cmd) throw bad(`test_commands[${n}]`, 'must be a non-empty command');
    if (SHELL_META.test(cmd)) {
      throw bad(`test_commands[${n}]`, `must be one plain command, no shell operators: ${cmd}`);
    }
    if (/^(\S*\/)?git(\s|$)/.test(cmd)) {
      throw bad(`test_commands[${n}]`, `may not run git (the daemon pushes): ${cmd}`);
    }
    return cmd;
  });
}

/**
 * `ci_watch` is file-only — it runs a command in the daemon —
 * so its command must already be one the human allowed in test_commands, and
 * its report paths stay inside the repository.
 */
function parseCiWatch(
  raw: Yaml | undefined,
  testCommands: string[],
  bad: (f: string, why: string) => Error,
): CiWatchConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('ci_watch', 'must be a map');
  const c = raw as { [k: string]: Yaml };
  if (typeof c.command !== 'string' || !c.command.trim()) {
    throw bad('ci_watch.command', 'is required');
  }
  const command = c.command.trim();
  if (!testCommands.includes(command)) {
    throw bad('ci_watch.command', `must be one of test_commands: ${command}`);
  }
  const reportsRaw =
    c.reports === undefined ? [] : Array.isArray(c.reports) ? c.reports : [c.reports];
  if (reportsRaw.length === 0)
    throw bad('ci_watch.reports', 'is required (where the JUnit XML lands)');
  const reports = reportsRaw.map((r, n) => {
    const path = typeof r === 'string' ? r.trim() : '';
    if (!path || path.startsWith('/') || path.split('/').includes('..')) {
      throw bad(`ci_watch.reports[${n}]`, `must be a path inside the repository: ${String(r)}`);
    }
    if (
      path
        .split('/')
        .slice(0, -1)
        .some((seg) => seg.includes('*'))
    ) {
      throw bad(`ci_watch.reports[${n}]`, `may use * only in the file name: ${path}`);
    }
    return path;
  });
  const dur = (key: 'every' | 'timeout', fallback: string, min: number, max: number) => {
    const v = c[key] === undefined ? fallback : String(c[key]);
    let s: number;
    try {
      s = parseDuration(v);
    } catch {
      throw bad(`ci_watch.${key}`, `must look like 30s, 15m or 1h, got '${v}'`);
    }
    if (s < min || s > max)
      throw bad(`ci_watch.${key}`, `must be between ${min / 60}m and ${max / 3600}h`);
    return s;
  };
  return {
    command,
    reports,
    everySeconds: dur('every', '2h', 300, 7 * 24 * 3600),
    timeoutSeconds: dur('timeout', '15m', 30, 3600),
  };
}

export function runtimeSettings(agent: { config_path: string }): RuntimeSettings {
  if (!isAbsolute(agent.config_path)) {
    return {
      config: null,
      dailyCeilingUsd: DEFAULT_DAILY_CEILING_USD,
      perPulseUsd: PER_SESSION_CEILING_USD,
      quietHours: [],
      allowDirty: false,
      logSources: [],
      noiseAllowlist: [],
      testCommands: [],
      ciWatch: null,
      inboxSource: null,
    };
  }
  const config = loadAgentConfig(agent.config_path);
  return {
    config,
    dailyCeilingUsd: config.budget.perDayUsd,
    perPulseUsd: config.budget.perPulseUsd,
    quietHours: config.quietHours,
    allowDirty: config.allowDirty,
    logSources: config.logSources,
    noiseAllowlist: config.noiseAllowlist,
    testCommands: config.testCommands,
    ciWatch: config.ciWatch,
    inboxSource: config.inboxSource,
  };
}
