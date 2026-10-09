import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { shouldFile } from '../store/dedupe.ts';
import { computeFingerprint, recordObservation } from '../store/observations.ts';
import { priorArt } from '../store/prior-art.ts';
import { writePulseFinding } from '../store/pulses.ts';
import { createTicket } from '../store/tickets.ts';
import type { Agent } from '../types.ts';
import type { LogEntry, LogQueryResult, LogSource, NoisePattern } from './types.ts';

export type { NoisePattern };

// ── FileLogSource ─────────────────────────────────────────────────────────────

type RawNdjsonEntry = {
  timestamp: string;
  eventMessage: string;
  messageType: string;
  subsystem?: string;
  category?: string;
};

function parseSeverity(messageType: string): LogEntry['severity'] {
  if (messageType === 'Fault') return 'fault';
  if (messageType === 'Error') return 'crash';
  if (messageType === 'Notice' || messageType === 'Warning') return 'warning';
  return 'info';
}

/**
 * Reads macOS `log show --style ndjson` output (or compatible ISO-timestamp
 * ndjson) from a file and filters entries to the requested window.
 *
 * Returns `{ kind: 'no_data' }` when the file does not exist — indicating
 * that log data is unavailable for the window (retention expired, source
 * offline) so the scan outcome should be `skipped`, not `clean`.
 */
export class FileLogSource implements LogSource {
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  query(window: { start: string; end: string }): LogQueryResult {
    if (!existsSync(this.filePath)) {
      return { kind: 'no_data' };
    }

    const raw = readFileSync(this.filePath, 'utf8');
    const entries: LogEntry[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: RawNdjsonEntry;
      try {
        parsed = JSON.parse(trimmed) as RawNdjsonEntry;
      } catch {
        continue;
      }

      const ts = parsed.timestamp;
      if (ts < window.start || ts >= window.end) continue;

      const codeLocation =
        [parsed.subsystem, parsed.category].filter(Boolean).join(':') || 'unknown';

      entries.push({
        timestamp: ts,
        message: parsed.eventMessage,
        code_location: codeLocation,
        severity: parseSeverity(parsed.messageType),
      });
    }

    return { kind: 'entries', entries };
  }
}

// ── PlainTextLogSource ────────────────────────────────────────────────────────

// Parses logs in the format: `YYYY-MM-DD HH:MM:SS [level] [component] message`
// Used for Electron/Node app logs (e.g. Claude desktop main.log).
export class PlainTextLogSource implements LogSource {
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  query(window: { start: string; end: string }): LogQueryResult {
    if (!existsSync(this.filePath)) return { kind: 'no_data' };

    const raw = readFileSync(this.filePath, 'utf8');
    const entries: LogEntry[] = [];
    // matches: 2026-09-27 00:04:48 [warn] [component] rest of message
    const RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \[([^\]]+)\] (.*)$/;

    for (const line of raw.split('\n')) {
      const m = RE.exec(line.trim());
      if (!m) continue;
      // Convert "YYYY-MM-DD HH:MM:SS" → ISO8601 local → compare as string
      const ts = new Date(m[1] as string).toISOString();
      if (ts < window.start || ts >= window.end) continue;
      entries.push({
        timestamp: ts,
        message: m[4] as string,
        code_location: m[3] as string,
        severity: parsePlainLevel(m[2] as string),
      });
    }

    return entries.length === 0 ? { kind: 'no_data' } : { kind: 'entries', entries };
  }
}

function parsePlainLevel(level: string): LogEntry['severity'] {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'fatal' || l === 'critical') return 'crash';
  if (l === 'warn' || l === 'warning') return 'warning';
  return 'info';
}

// ── scanLogs ──────────────────────────────────────────────────────────────────

export type ScanLogsResult = {
  outcome: 'clean' | 'finding' | 'skipped';
  ticketsFiled: number;
  entriesScanned: number;
  knownNoise: number;
  /** INFO lines observed this scan: counted, never ticketed by repetition. */
  infoCounted: number;
  /** Ticketable entries already covered by an open ticket via a duplicate link. */
  trackedOnExisting: number;
};

/**
 * Run the `logs.scan` every-pulse action.
 *
 * 1. Query the log source for the window.
 * 2. If no data: record `skipped` — the window exceeds retention, so the
 *    scan cannot report clean (it would be lying).
 * 3. For each entry: check allowlist (known noise), then fingerprint,
 *    upsert observation, check the ticketing threshold.
 * 4. If ticketable and no open ticket exists: run prior_art, file a ticket,
 *    record a `finding`.
 * 5. If no findings: record `clean`.
 */
export function scanLogs(
  db: Database.Database,
  agent: Agent,
  pulseId: number,
  window: { start: string; end: string },
  source: LogSource,
  allowlist: NoisePattern[] = [],
): ScanLogsResult {
  const queryResult = source.query(window);

  if (queryResult.kind === 'no_data') {
    writePulseFinding(db, {
      pulseId,
      actionKey: 'logs.scan',
      outcome: 'skipped',
      detail: 'no log data available for window — retention may have expired',
    });
    return {
      outcome: 'skipped',
      ticketsFiled: 0,
      entriesScanned: 0,
      knownNoise: 0,
      infoCounted: 0,
      trackedOnExisting: 0,
    };
  }

  const { entries } = queryResult;
  let ticketsFiled = 0;
  let knownNoise = 0;
  let infoCounted = 0;
  let trackedOnExisting = 0;
  const trackedOn = new Set<number>();

  const noisePatterns = allowlist
    .filter((p) => p.source === 'logs')
    .map((p) => new RegExp(p.pattern));

  for (const entry of entries) {
    if (noisePatterns.some((re) => re.test(entry.message))) {
      knownNoise++;
      continue;
    }

    const fingerprint = computeFingerprint('logs', entry.message, entry.code_location);

    if (entry.severity === 'info') infoCounted++;
    const obs = recordObservation(db, {
      fingerprint,
      source: 'logs',
      sample: entry.message,
      severity: entry.severity,
      pulseId,
    });

    if (!obs.ticketable) continue;

    // The noise rules in one place: open, suppressed, or tracked on another ticket.
    const decision = shouldFile(db, fingerprint, obs);
    if (!decision.file) {
      if (decision.reason === 'tracked') {
        trackedOnExisting++;
        trackedOn.add(decision.ticketId);
      }
      continue;
    }

    const title = `[logs] ${entry.message.slice(0, 120)}`;
    const body =
      `**Source:** \`${entry.code_location}\`\n\n` +
      `**Sample:**\n\`\`\`\n${entry.message}\n\`\`\`\n\n` +
      `**Occurrences:** ${obs.occurrences} across ${obs.pulse_count} pulse(s)`;

    const priors = priorArt(db, { title, body, fingerprint }, {});

    const priorBlock =
      priors.length > 0
        ? `\n\n**Prior art:** ${priors.map((p) => `#${p.id} — ${p.title}`).join('; ')}`
        : '';

    const ticketId = createTicket(
      db,
      {
        kind: 'bug',
        title,
        body: body + priorBlock,
        origin: 'collector:logs',
        fingerprint,
        origin_ref: fingerprint,
        priority: entry.severity === 'fault' || entry.severity === 'crash' ? 'p1' : 'p2',
        agent_id: agent.id,
        opened_pulse: pulseId,
        needs_triage: true,
      },
      { actor: agent.display_name, pulse_id: pulseId },
    );

    writePulseFinding(db, {
      pulseId,
      actionKey: 'logs.scan',
      outcome: 'finding',
      detail: `#${ticketId}: ${title.slice(0, 80)}`,
      ticketId,
    });
    ticketsFiled++;
  }

  if (ticketsFiled === 0) {
    const noiseNote = knownNoise > 0 ? `, ${knownNoise} known_noise` : '';
    const trackedNote =
      trackedOnExisting > 0
        ? `, ${trackedOnExisting} recurring entr${trackedOnExisting === 1 ? 'y' : 'ies'} already tracked on ${[...trackedOn].map((id) => `#${id}`).join(', ')}`
        : '';
    const infoNote = infoCounted > 0 ? `, ${infoCounted} info line(s) counted, not ticketed` : '';
    writePulseFinding(db, {
      pulseId,
      actionKey: 'logs.scan',
      outcome: 'clean',
      detail: `scanned ${entries.length} log entries, no new issues${trackedNote}${noiseNote}${infoNote}`,
    });
  }

  return {
    outcome: ticketsFiled > 0 ? 'finding' : 'clean',
    ticketsFiled,
    entriesScanned: entries.length,
    knownNoise,
    infoCounted,
    trackedOnExisting,
  };
}
