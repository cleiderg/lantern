/**
 * Running another program. Two shapes, no shell anywhere:
 *
 * - `execText`: run to completion and return its trimmed stdout; throws as
 *   `execFileSync` does, with `stderr` on the error.
 * - `runWithDeadline`: spawn, keep the output's tail, and at the deadline
 *   SIGTERM — the whole process group with `group` — then SIGKILL.
 *
 * The streaming `claude -p` harness and the detached daemon launcher keep
 * their own spawn: their lifecycles are not "run until done".
 */

import { execFileSync, spawn } from 'node:child_process';

export function execText(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

export type ProcResult = {
  /** Exit code; null when killed or never started. */
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved, as a terminal would show them. */
  output: string;
  /** Set when the program could not be started (ENOENT and the like). */
  error?: string;
};

export function runWithDeadline(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; group?: boolean; tail?: number; env?: NodeJS.ProcessEnv },
): Promise<ProcResult> {
  const tail = opts.tail ?? 1_000_000;
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: opts.group ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let output = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-tail);
      output = (output + d.toString()).slice(-tail);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-tail);
      output = (output + d.toString()).slice(-tail);
    });
    let timedOut = false;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (opts.group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref();
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdout, stderr, output, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, output });
    });
  });
}
