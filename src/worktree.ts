/**
 * Git worktree manager for write_branch sessions.
 * One worktree per ticket session — created at spawn, removed on close.
 *
 * Law 2: children may not operate outside their assigned worktree.
 * Enforcement is at the tool allowlist level (harness/tiers.ts). Law 1 (no push
 * to the default branch, no force-push) is enforced here, in git itself, by
 * installPushGuard: the guardrail lives in the environment first, and the
 * tool flags (harness/tiers.ts) are the backstop.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

/**
 * Create a git worktree at `worktreePath` checked out to a new branch `branchName`.
 * `repoPath` must be a git repository.
 * Throws on failure.
 */
export function createWorktree(repoPath: string, branchName: string, worktreePath: string): void {
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
}

/**
 * Remove a git worktree created by createWorktree.
 * Idempotent — if the worktree path doesn't exist, does nothing.
 */
export function destroyWorktree(repoPath: string, worktreePath: string): void {
  if (!existsSync(worktreePath)) return;
  try {
    git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // If git worktree remove fails (e.g. already detached), fall back to rm
    rmSync(worktreePath, { recursive: true, force: true });
    git(repoPath, ['worktree', 'prune']);
  }
}

/** Build a deterministic worktree path inside lanternDir for a session. */
export function worktreePath(lanternDir: string, sessionId: string): string {
  return join(lanternDir, 'worktrees', sessionId);
}

/**
 * Write a pre-push hook into `hooksDir` and return the env that points a
 * child's git at it. The hook refuses a push to the default branch, a
 * non-fast-forward (force) push, a remote ref deletion, and moving a tag that
 * is already on the remote.
 *
 * The hook is wired through git's environment config (GIT_CONFIG_COUNT /
 * core.hooksPath), not `.git/hooks`: a worktree shares that directory — and
 * the repo config — with the operator's own checkout, which must not change.
 * Only processes spawned with the returned env see the guard. Their own repo
 * hooks (e.g. pre-commit) are replaced by this directory for that session.
 */
export function installPushGuard(repoPath: string, hooksDir: string): Record<string, string> {
  const protectedBranches = new Set(['main', 'master']);
  const detected = defaultBranch(repoPath);
  if (detected) protectedBranches.add(detected);

  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-push');
  writeFileSync(hook, prePushScript([...protectedBranches]));
  chmodSync(hook, 0o755);

  return pushGuardEnv(hooksDir);
}

/** The env that routes git's hooks to `hooksDir` — for the child and the daemon's own push. */
export function pushGuardEnv(hooksDir: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
  };
}

/** origin's HEAD if known, else the branch the repo has checked out. */
export function defaultBranch(repoPath: string): string | null {
  for (const args of [
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['symbolic-ref', '--short', 'HEAD'],
  ]) {
    try {
      const ref = git(repoPath, args);
      if (ref) return ref.replace(/^origin\//, '');
    } catch {
      // try the next source
    }
  }
  return null;
}

function prePushScript(protectedBranches: string[]): string {
  return `#!/bin/sh
# Installed by Lantern for one child session (Laws 1 and 4).
protected="${protectedBranches.join(' ')}"
while read -r local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  for p in $protected; do
    if [ "$branch" = "$p" ]; then
      echo "lantern: push to default branch '$p' refused (Law 1)" >&2
      exit 1
    fi
  done
  case "$local_sha" in
    *[!0]*) ;;
    *) echo "lantern: deleting remote ref $remote_ref refused (Law 4)" >&2; exit 1 ;;
  esac
  case "$remote_ref" in
    refs/tags/*)
      case "$remote_sha" in
        *[!0]*) echo "lantern: moving tag $remote_ref on the remote refused (tags are immutable once pushed)" >&2; exit 1 ;;
      esac ;;
  esac
  case "$remote_sha" in
    *[!0]*)
      if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
        echo "lantern: non-fast-forward push to $remote_ref refused (Law 1: never force-push)" >&2
        exit 1
      fi ;;
  esac
done
exit 0
`;
}
