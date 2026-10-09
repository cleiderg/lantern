import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorktree, installPushGuard } from './worktree.ts';

// Hermetic git: no user/system config, fixed identity.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...env }, stdio: 'pipe' }).toString();
}

/** A repo with one commit on main, pushed to a bare `origin`. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-worktree-'));
  const remote = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: GIT_ENV });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  return { dir, repo, remote, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A worktree on its own branch, guard installed, one new commit. */
function guardedWorktree() {
  const f = fixtureRepo();
  const wt = join(f.dir, 'wt');
  createWorktree(f.repo, 'lantern/fix-1', wt);
  const env = installPushGuard(f.repo, join(f.dir, 'hooks'));
  writeFileSync(join(wt, 'a.txt'), 'two\n');
  git(wt, ['commit', '-qam', 'fix']);
  const push = (args: string[]) => git(wt, ['push', '-q', ...args], env);
  return { ...f, wt, env, push };
}

test('push guard: a push to the session branch is allowed', () => {
  const g = guardedWorktree();
  try {
    g.push(['origin', 'HEAD:refs/heads/lantern/fix-1']);
    assert.match(git(g.remote, ['branch']), /lantern\/fix-1/);
  } finally {
    g.cleanup();
  }
});

test('push guard: a push to the default branch is refused (Law 1)', () => {
  const g = guardedWorktree();
  try {
    assert.throws(() => g.push(['origin', 'HEAD:main']), /default branch/);
    assert.throws(() => g.push(['origin', 'HEAD:refs/heads/main']), /default branch/);
    assert.equal(git(g.remote, ['log', '--format=%s', 'main']).trim(), 'init');
  } finally {
    g.cleanup();
  }
});

test('push guard: a force-push is refused even to the session branch (Law 1)', () => {
  const g = guardedWorktree();
  try {
    g.push(['origin', 'HEAD:refs/heads/lantern/fix-1']);
    git(g.wt, ['commit', '-q', '--amend', '-m', 'rewritten']);
    assert.throws(() => g.push(['--force', 'origin', 'HEAD:refs/heads/lantern/fix-1']), /force/);
    assert.throws(() => g.push(['origin', '+HEAD:refs/heads/lantern/fix-1']), /force/);
  } finally {
    g.cleanup();
  }
});

test('push guard: deleting a remote branch is refused (Law 4)', () => {
  const g = guardedWorktree();
  try {
    g.push(['origin', 'HEAD:refs/heads/lantern/fix-1']);
    assert.throws(() => g.push(['origin', ':refs/heads/lantern/fix-1']), /delet/);
  } finally {
    g.cleanup();
  }
});

test("push guard: installing it does not touch the operator's repo config or hooks", () => {
  const f = fixtureRepo();
  try {
    const before = git(f.repo, ['config', '--local', '--list']);
    installPushGuard(f.repo, join(f.dir, 'hooks'));
    assert.equal(git(f.repo, ['config', '--local', '--list']), before);
    // The operator can still push to main from their own checkout.
    writeFileSync(join(f.repo, 'a.txt'), 'operator\n');
    git(f.repo, ['commit', '-qam', 'operator change']);
    git(f.repo, ['push', '-q', 'origin', 'main']);
  } finally {
    f.cleanup();
  }
});
