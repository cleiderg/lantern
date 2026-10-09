/**
 * Stored timestamps come in two formats: JS `toISOString()`
 * (`2026-10-05T12:00:00.000Z`) and SQLite's `datetime('now')`
 * (`2026-10-05 12:00:00`, zoneless, UTC by convention). every read
 * in JS goes through `parseStoredTime`; in SQL, compare and subtract through
 * `julianday()`, which reads both. The page's copy is `ui/js/format.js`
 * `parseTs`, held equal by time.test.ts.
 */

/** Milliseconds since the epoch, or NaN for an unreadable value. */
export function parseStoredTime(ts: string): number {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(ts);
  return new Date(hasZone ? ts : `${ts.replace(' ', 'T')}Z`).getTime();
}

/** "42s", "5m", "3h", "2d" — the age of a stored timestamp at `now`. */
export function formatAge(ts: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - parseStoredTime(ts)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
