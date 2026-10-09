import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { LogSourceConfig } from '../agent-config.ts';
import type { Agent } from '../types.ts';
import { FileInboxSource, scanInbox } from './inbox-bugs.ts';
import { FileLogSource, type NoisePattern, PlainTextLogSource, scanLogs } from './logs-scan.ts';
import type { InboxSource, LogSource } from './types.ts';

export type CollectPhaseOpts = {
  logSource?: LogSource;
  inboxSource?: InboxSource;
  /** From the agent config. Each is scanned; empty falls back to LANTERN_LOG_SOURCE. */
  logSources?: LogSourceConfig[];
  /** Known-benign patterns from the agent config. */
  noiseAllowlist?: NoisePattern[];
  /** Bug-inbox JSON path from the agent config; falls back to LANTERN_INBOX_SOURCE. */
  inboxPath?: string | null;
};

/**
 * Run all enabled collectors for the current pulse.
 *
 * Sources are injectable (for tests). If not provided, the function falls back
 * to env vars LANTERN_LOG_SOURCE and LANTERN_INBOX_SOURCE. If neither is set, that
 * collector is skipped silently — no finding is written and the orchestrator
 * turn still runs.
 *
 * Decision 11: this runs as a `collect` phase before the orchestrator turn so
 * the digest the turn receives already reflects fresh findings.
 */
export function runCollectors(
  db: Database.Database,
  agent: Agent,
  pulseId: number,
  window: { window_start: string; window_end: string },
  opts: CollectPhaseOpts = {},
): void {
  const scanWindow = { start: window.window_start, end: window.window_end };

  const allowlist = opts.noiseAllowlist ?? [];
  const logSources: LogSource[] = opts.logSource
    ? [opts.logSource]
    : opts.logSources?.length
      ? opts.logSources.map((s) => buildLogSource(s.path, s.format)).filter((s) => s !== null)
      : [buildLogSource()].filter((s) => s !== null);
  for (const logSource of logSources) {
    scanLogs(db, agent, pulseId, scanWindow, logSource, allowlist);
  }

  const inboxSource =
    opts.inboxSource ?? (opts.inboxPath ? new FileInboxSource(opts.inboxPath) : buildInboxSource());
  if (inboxSource) {
    scanInbox(db, agent, pulseId, scanWindow, inboxSource);
  }
}

export function buildLogSource(
  pathOverride?: string,
  format?: LogSourceConfig['format'],
): LogSource | null {
  const path = pathOverride ?? process.env.LANTERN_LOG_SOURCE;
  if (!path) return null;
  if (format === 'ndjson') return new FileLogSource(path);
  if (format === 'plain') return new PlainTextLogSource(path);
  // Auto-detect format: peek at the first non-empty line; ndjson if it parses as JSON.
  if (existsSync(path)) {
    const firstLine =
      readFileSync(path, 'utf8')
        .split('\n')
        .find((l) => l.trim()) ?? '';
    try {
      JSON.parse(firstLine);
      return new FileLogSource(path);
    } catch {
      /* plain text */
    }
  }
  return new PlainTextLogSource(path);
}

function buildInboxSource(): InboxSource | null {
  const path = process.env.LANTERN_INBOX_SOURCE;
  return path ? new FileInboxSource(path) : null;
}
