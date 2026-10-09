import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Observation } from '../types.ts';

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Strip variable parts of a log message so two lines that describe the same
 * event but differ only in a timestamp, UUID, address, or number produce the
 * same normalized form.
 *
 * Stripping order matters: ISO timestamps and UUIDs must be replaced before
 * the generic number sweep so their digit runs don't partially match first.
 */
export function normalizeMessage(msg: string): string {
  return (
    msg
      // ISO 8601 timestamps (full precision, any timezone offset)
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      // UUIDs (v1–v5, any case)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      // Hex memory addresses (0x…)
      .replace(/0x[0-9a-f]+/gi, '<addr>')
      // All remaining standalone integers — covers ports, line numbers, counts
      .replace(/\b\d+\b/g, 'N')
  );
}

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * sha1(source + '\0' + normalized_message + '\0' + code_location)
 *
 * Two observations are the same event if they share a source, the same
 * normalized message, and the same code location.
 */
export function computeFingerprint(source: string, message: string, codeLocation: string): string {
  return createHash('sha1')
    .update(`${source}\x00${normalizeMessage(message)}\x00${codeLocation}`)
    .digest('hex');
}

// ── Observation record / threshold check ──────────────────────────────────────

export type ObservationResult = {
  ticketable: boolean;
  suppressed: boolean;
  rate_spike: boolean;
  occurrences: number;
  pulse_count: number;
};

/**
 * Upsert a fingerprint into the observations table, then return whether it
 * clears the ticketing threshold:
 *
 *   1. severity is 'fault' or 'crash'  →  ticketable immediately
 *   2. occurrences ≥ 3 AND pulse_count ≥ 2  →  survived across pulses
 *   3. a human previously filed a ticket with this fingerprint
 *
 * Suppressed fingerprints still increment occurrences (so the rate-spike
 * detector can fire), but ticketable is forced false unless the rate has
 * jumped 10× above the baseline measured at suppression time.
 */
export function recordObservation(
  db: Database.Database,
  opts: {
    fingerprint: string;
    source: string;
    sample: string;
    severity?: string;
    pulseId?: number | null;
  },
): ObservationResult {
  const { fingerprint, source, sample, severity, pulseId = null } = opts;
  const now = new Date().toISOString();

  db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM observations WHERE fingerprint = ?')
      .get(fingerprint) as Observation | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO observations
           (fingerprint, source, sample, last_pulse_id, occurrences, pulse_count)
         VALUES (?, ?, ?, ?, 1, 1)`,
      ).run(fingerprint, source, sample, pulseId);
      return;
    }

    // Clear expired suppression before counting so the TTL is honoured.
    if (existing.suppressed && existing.suppress_until && existing.suppress_until < now) {
      db.prepare(
        `UPDATE observations
         SET suppressed = 0, suppress_until = NULL, suppress_reason = NULL,
             occurrences_at_suppress = NULL, pulse_count_at_suppress = NULL
         WHERE fingerprint = ?`,
      ).run(fingerprint);
    }

    db.prepare(
      `UPDATE observations
       SET occurrences = occurrences + 1, last_seen = datetime('now'), sample = ?
       WHERE fingerprint = ?`,
    ).run(sample, fingerprint);

    const isNewPulse = pulseId !== null && existing.last_pulse_id !== pulseId;
    if (isNewPulse) {
      db.prepare(
        `UPDATE observations
         SET pulse_count = pulse_count + 1, last_pulse_id = ?
         WHERE fingerprint = ?`,
      ).run(pulseId, fingerprint);
    }
  })();

  const final = db
    .prepare('SELECT * FROM observations WHERE fingerprint = ?')
    .get(fingerprint) as Observation;

  // Rate-spike detection: only meaningful once a baseline was recorded.
  let rateSpike = false;
  if (
    final.suppressed &&
    final.occurrences_at_suppress !== null &&
    final.pulse_count_at_suppress !== null
  ) {
    const baseOcc = final.occurrences_at_suppress;
    const basePulses = final.pulse_count_at_suppress;
    if (basePulses > 0) {
      const baselineRate = baseOcc / basePulses;
      const incrOcc = final.occurrences - baseOcc;
      const incrPulses = final.pulse_count - basePulses;
      if (incrPulses > 0 && baselineRate > 0 && incrOcc / incrPulses > 10 * baselineRate) {
        rateSpike = true;
      }
    }
  }

  // Threshold evaluation
  const isFaultCrash = severity === 'fault' || severity === 'crash';
  // An INFO line that recurs is the system working normally — recurrence is
  // what INFO lines do. It is still counted (so it can be seen trending) but
  // never crosses the bar on its own (a deliberate deviation from
  // the severity-blind rule 2 above). A human ticket for it still wins, below.
  const isCrossedOccurrenceBar =
    severity !== 'info' && final.occurrences >= 3 && final.pulse_count >= 2;
  const hasPriorHumanTicket =
    db
      .prepare(`SELECT id FROM tickets WHERE fingerprint = ? AND origin = 'human' LIMIT 1`)
      .get(fingerprint) !== undefined;

  const baseTicketable = isFaultCrash || isCrossedOccurrenceBar || hasPriorHumanTicket;
  const ticketable = baseTicketable && (!final.suppressed || rateSpike);

  return {
    ticketable,
    suppressed: Boolean(final.suppressed),
    rate_spike: rateSpike,
    occurrences: final.occurrences,
    pulse_count: final.pulse_count,
  };
}

// ── Suppression ───────────────────────────────────────────────────────────────

/**
 * Mark a fingerprint as suppressed for `ttlDays` days.
 * Records the current occurrences/pulse_count as the baseline for rate-spike
 * detection. No-op if the fingerprint is unknown.
 */
export function suppressFingerprint(
  db: Database.Database,
  fingerprint: string,
  reason: string,
  ttlDays = 30,
): void {
  const existing = db
    .prepare('SELECT occurrences, pulse_count FROM observations WHERE fingerprint = ?')
    .get(fingerprint) as { occurrences: number; pulse_count: number } | undefined;

  if (!existing) return;

  const suppressUntil = new Date(Date.now() + ttlDays * 24 * 3600 * 1000).toISOString();
  db.prepare(
    `UPDATE observations
     SET suppressed = 1, suppress_until = ?, suppress_reason = ?,
         occurrences_at_suppress = ?, pulse_count_at_suppress = ?
     WHERE fingerprint = ?`,
  ).run(suppressUntil, reason, existing.occurrences, existing.pulse_count, fingerprint);
}
