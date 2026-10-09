// Lantern UI: formatting that the server also does — kept equal to src/format.ts
// by src/format.test.ts. No DOM here, so Node can import it.

/** 3600 → "1h", 900 → "15m", 90 → "90s": the largest unit that is exact. */
export function fmtDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Stored timestamps come in two formats — see src/time.ts. Null if unreadable. */
export function parseTs(ts) {
  if (!ts) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(ts);
  const ms = new Date(hasZone ? ts : `${ts.replace(' ', 'T')}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}
