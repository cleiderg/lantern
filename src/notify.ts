import { spawn } from 'node:child_process';

export type NotifyOpts = {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
};

/**
 * Fire a local macOS notification, alongside `lantern inbox`. No-op on
 * non-darwin platforms — there is no cross-platform fallback. Best-effort: a notification failure must never
 * break the pulse that triggered it.
 */
export function notify(title: string, message: string, opts: NotifyOpts = {}): void {
  // Defense in depth: subprocess-spawned tests (e.g. `lantern start`) exercise
  // real daemon code paths and must never pop a real system notification.
  if (process.env.LANTERN_DISABLE_NOTIFY === '1') return;

  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return;

  const spawnFn = opts.spawnFn ?? spawn;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  try {
    const child = spawnFn('osascript', ['-e', script], { stdio: 'ignore' });
    child.unref();
  } catch {
    // best-effort — notification delivery is not on the critical path
  }
}
