/**
 * Every git call Lantern makes goes through here: argument lists,
 * never a command string, output trimmed. Throws on a non-zero exit, with
 * git's `stderr` on the error.
 */

import { execText } from './proc.ts';

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execText('git', args, { cwd, env });
}

/** git's output as non-empty lines. */
export function gitLines(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string[] {
  return git(cwd, args, env)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
