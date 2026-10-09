/** What every `lantern` command shares. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionResult } from '../actions.ts';
import type { HarnessAdapter } from '../harness/types.ts';

/** One command invocation: argv past the command name's position, streams, the store. */
export type CliCtx = {
  argv: string[];
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  lanternDir: string;
  harness?: HarnessAdapter;
};

/** The store's path, or null after saying how to create it — once, for every command. */
export function requireDb(c: CliCtx): string | null {
  const dbPath = join(c.lanternDir, 'lantern.db');
  if (existsSync(dbPath)) return dbPath;
  c.err.write('lantern: not initialized — run `lantern init` first\n');
  return null;
}

/** Returns the value of a named flag (e.g. --agent joe → 'joe'), or undefined. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Print an action's result the way every CLI command always has. */
export function report(
  result: ActionResult,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  cmd: string,
): number {
  if (!result.ok) {
    err.write(`lantern ${cmd}: ${result.error}\n`);
    return 1;
  }
  for (const m of result.messages) out.write(`lantern: ${m}\n`);
  return 0;
}
