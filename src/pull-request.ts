/**
 * Opening a PR. After a write child finishes, the
 * daemon (not the model) pushes the session branch and opens a **draft** PR
 * with `gh`. Draft, because Law 3 allows drafting,
 * not publishing; a human marks it ready.
 *
 * a PR is opened only where one can be — `origin` is a GitHub URL
 * and `gh` is installed. Anywhere else the pushed branch is the review
 * artifact, and that is a success, not a failure.
 *
 * The push runs with the session's push-guard env, so it is held to the same
 * Law 1 rules as the child's own pushes.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { git, gitLines } from './git.ts';
import { execText } from './proc.ts';

export type PublishResult =
  | { ok: true; kind: 'pr'; url: string }
  | { ok: true; kind: 'branch'; remote: string; why: string }
  | { ok: false; stage: 'push' | 'pr'; error: string };

const GITHUB_URL =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/;

/** origin's URL as configured (not rewritten by insteadOf), or null. */
function originUrl(cwd: string): string | null {
  try {
    return git(cwd, ['config', '--get', 'remote.origin.url']);
  } catch {
    return null;
  }
}

/** Whether `gh` is on PATH — looked up, never run, so a broken gh still counts as present. */
export function ghOnPath(path = process.env.PATH ?? ''): boolean {
  return path.split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, 'gh'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const errorText = (e: unknown) =>
  (e as { stderr?: Buffer }).stderr?.toString().trim() ||
  (e instanceof Error ? e.message : String(e));

export function publishBranch(opts: {
  worktree: string;
  branch: string;
  title: string;
  body: string;
  gitEnv: Record<string, string>;
}): PublishResult {
  const env = { ...process.env, ...opts.gitEnv };
  try {
    git(opts.worktree, ['push', '-q', 'origin', `HEAD:refs/heads/${opts.branch}`], env);
  } catch (e) {
    return { ok: false, stage: 'push', error: errorText(e) };
  }

  const remote = originUrl(opts.worktree) ?? 'origin';
  if (!GITHUB_URL.test(remote)) {
    return { ok: true, kind: 'branch', remote, why: 'origin is not a GitHub repository' };
  }
  if (!ghOnPath(env.PATH)) {
    return { ok: true, kind: 'branch', remote, why: 'gh is not installed' };
  }
  try {
    const out = execText(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--head',
        opts.branch,
        '--title',
        opts.title,
        '--body',
        opts.body,
      ],
      { cwd: opts.worktree, env },
    );
    const url = out.split('\n').at(-1) ?? '';
    return url
      ? { ok: true, kind: 'pr', url }
      : { ok: false, stage: 'pr', error: 'gh pr create printed no URL' };
  } catch (e) {
    return { ok: false, stage: 'pr', error: errorText(e) };
  }
}

/**
 * After an approved release child, push the one tag it put on
 * its branch head. The push guard refuses to move a tag the remote already has.
 */
export function pushReleaseTag(opts: {
  worktree: string;
  gitEnv: Record<string, string>;
}): { ok: true; tag: string } | { ok: false; error: string } {
  const env = { ...process.env, ...opts.gitEnv };
  let tags: string[];
  try {
    tags = gitLines(opts.worktree, ['tag', '--points-at', 'HEAD'], env);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  if (tags.length !== 1) {
    return {
      ok: false,
      error: tags.length
        ? `the release child left ${tags.length} tags on its head (${tags.join(', ')}); expected one`
        : 'the release child created no tag on its branch head',
    };
  }
  const tag = tags[0] as string;
  try {
    git(opts.worktree, ['push', '-q', 'origin', `refs/tags/${tag}`], env);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  return { ok: true, tag };
}
