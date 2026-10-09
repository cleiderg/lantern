/**
 * What the trial log converters share: the local-time stamp
 * `PlainTextLogSource` reads, and the stdin → stdout pipe that drops and
 * counts lines that are not log lines.
 */

import { createInterface } from 'node:readline';

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO-8601 stamp with a zone → `YYYY-MM-DD HH:MM:SS` local time, or null. */
export function localStamp(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Run `convert` over stdin when `moduleUrl` is the script node was started with. */
export function pipeIfMain(
  moduleUrl: string,
  name: string,
  convert: (line: string) => string | null,
): void {
  if (moduleUrl !== `file://${process.argv[1]}`) return;
  let dropped = 0;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const out = convert(line);
    if (out) process.stdout.write(`${out}\n`);
    else dropped++;
  });
  rl.on('close', () => process.stderr.write(`${name}: ${dropped} non-log line(s) dropped\n`));
}
