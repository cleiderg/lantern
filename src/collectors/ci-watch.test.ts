import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { lastRun, runResults } from '../store/ci.ts';
import { createRunningPulse, getPulseFindings } from '../store/pulses.ts';
import { runCiWatch } from './ci-watch.ts';

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, stdio: 'pipe' }).toString().trim();

/** A repo whose test script writes a JUnit report — passing unless FAIL exists in the repo. */
function world(script?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-ci-watch-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
  writeFileSync(
    join(repo, 'run-tests.sh'),
    script ??
      `mkdir -p reports
if [ -f FAIL ]; then outcome='<failure message="expected 404 but was 500">stack</failure>'; else outcome=''; fi
cat > reports/TEST-owner.xml <<XML
<testsuite name="Owner"><testcase classname="Owner" name="finds"/><testcase classname="Owner" name="notFound">$outcome</testcase></testsuite>
XML
[ -f FAIL ] && exit 1
exit 0
`,
  );
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  const agent = { ...ensureDefaultAgent(db, repo), workdir: repo };
  const pulse = () => createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' });
  const cfg = {
    command: 'sh run-tests.sh',
    reports: ['reports/*.xml'],
    everySeconds: 7200,
    timeoutSeconds: 30,
  };
  return {
    dir,
    lanternDir,
    db,
    repo,
    agent,
    pulse,
    cfg,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('runCiWatch: runs the test command on main in a scratch worktree, records the run, cleans up', async () => {
  const w = world();
  try {
    const sha = git(w.repo, ['rev-parse', 'main']);
    const p = w.pulse();
    const r = await runCiWatch(w.db, w.agent, p, w.cfg, { lanternDir: w.lanternDir });
    assert.equal(r.outcome, 'ran');
    const run = lastRun(w.db, w.agent.id);
    assert.equal(run?.commit_sha, sha);
    assert.equal(run?.status, 'passed');
    assert.deepEqual(
      runResults(w.db, run?.id as number).map((x) => [x.test_id, x.outcome]),
      [
        ['Owner#finds', 'pass'],
        ['Owner#notFound', 'pass'],
      ],
    );
    assert.ok(!existsSync(join(w.repo, 'reports')), 'never in the operator checkout');
    assert.deepEqual(
      readdirSync(join(w.lanternDir, 'ci-worktrees')),
      [],
      'scratch worktree removed',
    );
    assert.equal(git(w.repo, ['worktree', 'list']).split('\n').length, 1);
    const f = getPulseFindings(w.db, p).find((x) => x.action_key === 'ci.watch');
    assert.equal(f?.outcome, 'clean');
    assert.match(f?.detail ?? '', /2 tests passed/);
  } finally {
    w.cleanup();
  }
});

test('runCiWatch: not due → skipped with when it is next due; due again after `every`', async () => {
  const w = world();
  try {
    const t0 = new Date();
    await runCiWatch(w.db, w.agent, w.pulse(), w.cfg, { lanternDir: w.lanternDir, now: t0 });
    const p2 = w.pulse();
    const second = await runCiWatch(w.db, w.agent, p2, w.cfg, {
      lanternDir: w.lanternDir,
      now: new Date(t0.getTime() + 60_000),
    });
    assert.equal(second.outcome, 'not_due');
    const f = getPulseFindings(w.db, p2).find((x) => x.action_key === 'ci.watch');
    assert.equal(f?.outcome, 'skipped');
    assert.match(f?.detail ?? '', /not due until .*last run: passed/);
    const third = await runCiWatch(w.db, w.agent, w.pulse(), w.cfg, {
      lanternDir: w.lanternDir,
      now: new Date(t0.getTime() + 7200_000 + 1000),
    });
    assert.equal(third.outcome, 'ran');
  } finally {
    w.cleanup();
  }
});

test('runCiWatch: a failing test is a finding; no report at all is a broken build; a hang is a timeout', async () => {
  const w = world();
  try {
    writeFileSync(join(w.repo, 'FAIL'), '');
    git(w.repo, ['add', 'FAIL']);
    git(w.repo, ['commit', '-qm', 'break it']);
    const p = w.pulse();
    await runCiWatch(w.db, w.agent, p, w.cfg, { lanternDir: w.lanternDir });
    assert.equal(lastRun(w.db, w.agent.id)?.status, 'failed');
    assert.equal(
      getPulseFindings(w.db, p).find((x) => x.action_key === 'ci.watch')?.outcome,
      'finding',
    );
  } finally {
    w.cleanup();
  }
  const broken = world('echo "error: cannot find symbol" >&2\nexit 1\n');
  try {
    await runCiWatch(broken.db, broken.agent, broken.pulse(), broken.cfg, {
      lanternDir: broken.lanternDir,
    });
    const run = lastRun(broken.db, broken.agent.id);
    assert.equal(run?.status, 'broken');
    assert.match(run?.detail ?? '', /cannot find symbol/);
  } finally {
    broken.cleanup();
  }
  const hang = world('sleep 30\n');
  try {
    const t = Date.now();
    await runCiWatch(
      hang.db,
      hang.agent,
      hang.pulse(),
      { ...hang.cfg, timeoutSeconds: 1 },
      { lanternDir: hang.lanternDir },
    );
    assert.equal(lastRun(hang.db, hang.agent.id)?.status, 'timeout');
    assert.ok(Date.now() - t < 10_000, 'killed at the deadline');
    assert.deepEqual(
      readdirSync(join(hang.lanternDir, 'ci-worktrees')),
      [],
      'cleaned up after a timeout too',
    );
  } finally {
    hang.cleanup();
  }
});

test('runCiWatch → ticketing: two failing runs file one ticket, linked from the finding', async () => {
  const w = world();
  try {
    writeFileSync(join(w.repo, 'FAIL'), '');
    git(w.repo, ['add', 'FAIL']);
    git(w.repo, ['commit', '-qm', 'break it']);
    const t0 = Date.now();
    await runCiWatch(w.db, w.agent, w.pulse(), w.cfg, {
      lanternDir: w.lanternDir,
      now: new Date(t0),
    });
    const p2 = w.pulse();
    await runCiWatch(w.db, w.agent, p2, w.cfg, {
      lanternDir: w.lanternDir,
      now: new Date(t0 + 7200_000 + 1),
    });
    const f = getPulseFindings(w.db, p2).find((x) => x.action_key === 'ci.watch');
    assert.equal(f?.outcome, 'finding');
    assert.ok(f?.ticket_id, 'the finding names the ticket');
    const t = w.db
      .prepare('SELECT title, origin, needs_triage FROM tickets WHERE id = ?')
      .get(f?.ticket_id) as {
      title: string;
      origin: string;
      needs_triage: number;
    };
    assert.deepEqual(t, {
      title: '[ci] Failing: Owner#notFound',
      origin: 'collector:ci',
      needs_triage: 1,
    });
  } finally {
    w.cleanup();
  }
});
