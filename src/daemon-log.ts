/**
 * The daemon log: structured JSON in ~/.lantern/logs/lanternd.log, rotated
 * daily. One JSON object per line — `{ts, level, agent, msg}` — so a log can be
 * filtered by agent or level without parsing prose. At the first write of a new
 * UTC day the previous day's file becomes `lanternd-YYYY-MM-DD.log`.
 *
 * Several daemons (one per agent) append to the same file; the `agent` field
 * tells their lines apart. Rotation is idempotent: whichever process writes
 * first on a new day renames the file, the others find it already fresh.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (msg: string, level?: LogLevel) => void;

export const daemonLogDir = (lanternDir: string) => join(lanternDir, 'logs');
export const daemonLogPath = (lanternDir: string) => join(daemonLogDir(lanternDir), 'lanternd.log');

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The UTC day of the file's first line, or null when the file is empty or unreadable. */
function fileDay(path: string): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const m = /"ts":"(\d{4}-\d{2}-\d{2})T/.exec(buf.subarray(0, n).toString('utf8'));
      return m ? (m[1] as string) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A level from the message when the caller gave none: pulse lines say "error" in prose. */
function inferLevel(msg: string): LogLevel {
  if (/\b(error|failed|crash(ed)?)\b/i.test(msg)) return 'error';
  if (/\b(warn(ing)?|refused|tripped)\b/i.test(msg)) return 'warn';
  return 'info';
}

export function createDaemonLogger(
  lanternDir: string,
  agentId: string | null,
  now: () => Date = () => new Date(),
): Logger {
  const dir = daemonLogDir(lanternDir);
  const path = daemonLogPath(lanternDir);
  let checkedDay: string | null = null;
  return (msg, level) => {
    const t = now();
    const today = day(t);
    if (checkedDay !== today) {
      mkdirSync(dir, { recursive: true });
      const was = existsSync(path) ? fileDay(path) : null;
      if (was && was !== today) {
        try {
          renameSync(path, join(dir, `lanternd-${was}.log`));
        } catch {
          // another daemon rotated it first
        }
      }
      checkedDay = today;
    }
    const line = { ts: t.toISOString(), level: level ?? inferLevel(msg), agent: agentId, msg };
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  };
}

/** Every daemon log line's message, oldest file first — for tests and quick reads. */
export function readDaemonLog(lanternDir: string): string {
  const dir = daemonLogDir(lanternDir);
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir)
    .filter((f) => /^lanternd(-\d{4}-\d{2}-\d{2})?\.log$/.test(f))
    .sort((a, b) => (a === 'lanternd.log' ? 1 : b === 'lanternd.log' ? -1 : a.localeCompare(b)));
  return files
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => {
      try {
        return (JSON.parse(l) as { msg: string }).msg;
      } catch {
        return l;
      }
    })
    .join('\n');
}
