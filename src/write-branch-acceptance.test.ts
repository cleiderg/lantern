/**
 * Write-branch and release acceptance, end to end.
 *
 * The orchestrator files a bug and staffs a `write_branch` child; the child
 * fixes it in a worktree on its own branch, the ticket moves to `in_review`,
 * and the worktree is cleaned up. Pushes to main are blocked by the tool
 * layer, not by the prompt, and the concurrency ceiling holds under a queue
 * of 20 tickets. Opening a PR is covered by the `gh` tests at the end.
 *
 * A `release`-tier request blocks until approved in `lantern inbox` and
 * cannot be started any other way.
 *
 * Real pieces: the MCP tool handlers, reapSessions, worktree creation, the
 * push guard, git with a bare remote, `lantern inbox approve`. Simulated: only the
 * model — ChildSim does in the child's cwd and env what a fixer would.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { run } from './cli.ts';
import { openDb } from './db.ts';
import { reapSessions } from './harness/session-runner.ts';
import type { HarnessAdapter, SessionSpec, SessionState } from './harness/types.ts';
import { initLantern } from './init.ts';
import type { McpContext } from './mcp/context.ts';
import { callTool } from './mcp/tools.ts';
import { createRunningPulse } from './store/pulses.ts';
import { getSession } from './store/sessions.ts';
import { getTicket } from './store/tickets.ts';
import { installPushGuard } from './worktree.ts';

const IDENTITY = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'child',
  GIT_AUTHOR_EMAIL: 'child@example.invalid',
  GIT_COMMITTER_NAME: 'child',
  GIT_COMMITTER_EMAIL: 'child@example.invalid',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...IDENTITY, ...env },
    stdio: 'pipe',
  }).toString();
}

function sink(): Writable & { text: string } {
  const w = new Writable({
    write(chunk, _enc, cb) {
      w.text += chunk.toString();
      cb();
    },
  }) as Writable & { text: string };
  w.text = '';
  return w;
}

/** Stands in for the model: fixes the bug in its cwd, then tries its luck. */
class ChildSim implements HarnessAdapter {
  specs: SessionSpec[] = [];
  pushToMain = '';
  forcePush = '';
  async run(spec: SessionSpec) {
    this.specs.push(spec);
    // The child's git sees exactly the env the harness would give `claude`.
    const env = spec.env ?? {};
    writeFileSync(join(spec.cwd, 'parser.ts'), 'export const fixed = true;\n');
    git(spec.cwd, ['add', '.'], env);
    git(spec.cwd, ['commit', '-qm', 'fix parser'], env);
    git(spec.cwd, ['push', '-q', 'origin', 'HEAD:refs/heads/lantern/fix-parser'], env);
    try {
      git(spec.cwd, ['push', '-q', 'origin', 'HEAD:main'], env);
    } catch (e) {
      this.pushToMain = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    try {
      git(spec.cwd, ['commit', '-q', '--amend', '-m', 'rewrite'], env);
      git(spec.cwd, ['push', '-q', '--force', 'origin', 'HEAD:refs/heads/lantern/fix-parser'], env);
    } catch (e) {
      this.forcePush = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    return { id: `child-${this.specs.length}` };
  }
  async poll(): Promise<SessionState> {
    return {
      status: 'done',
      costUsd: 0.3,
      numTurns: 5,
      durationMs: 1000,
      isError: false,
      result: 'fixed',
      sessionId: 'x',
    };
  }
  async interrupt() {}
  async kill() {}
}

/** A harness whose children never finish — for the concurrency check. */
const busy: HarnessAdapter = {
  run: async () => ({ id: 'busy' }),
  poll: () => new Promise<SessionState>(() => {}),
  interrupt: async () => {},
  kill: async () => {},
};

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-write-accept-'));
  const lanternDir = join(dir, 'lantern');
  const remote = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'parser.ts'), 'export const fixed = false;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);

  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = { ...ensureDefaultAgent(db, repo), workdir: repo };
  db.prepare('UPDATE agents SET workdir = ? WHERE id = ?').run(repo, agent.id);
  const pulse = () => createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' });
  const pulseId = pulse();
  const ctx: McpContext = {
    lanternDir,
    agentId: agent.id,
    pulseId,
    sessionId: null,
    ticketId: null,
    tier: 'orchestrator',
  };
  const eventCtx = { actor: agent.id, pulse_id: pulseId, session_id: null };
  const tool = (name: string, args: Record<string, unknown>) => {
    const r = callTool(db, ctx, eventCtx, name, args);
    return { error: r.isError === true, text: r.content[0]?.text ?? '' };
  };
  const fileBug = (title: string) =>
    (
      JSON.parse(
        tool('tickets_create', { kind: 'bug', title, body: 'b', origin: 'agent:self' }).text,
      ) as {
        id: number;
      }
    ).id;
  return {
    dir,
    lanternDir,
    remote,
    repo,
    db,
    agent,
    pulse,
    tool,
    fileBug,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('bug → write_branch child in its own worktree → in_review → cleaned up; main and force-push refused', async () => {
  const w = world();
  try {
    const ticketId = w.fileBug('Parser drops trailing field');
    const staffed = w.tool('staff_ticket', {
      ticket_id: ticketId,
      tier: 'write_branch',
      label: 'fix-parser',
    });
    assert.equal(staffed.error, false, staffed.text);
    const sessionId = (JSON.parse(staffed.text) as { session_id: string }).session_id;

    const child = new ChildSim();
    // Never the machine's real gh: completion now opens a PR.
    await withFakeGh(w.dir, "echo 'https://github.example/o/r/pull/1'", async () => {
      await reapSessions(w.db, w.agent, w.lanternDir, w.pulse(), child);
      await new Promise((r) => setTimeout(r, 200)); // completion is recorded asynchronously
    });

    // Own worktree, own branch.
    const spec = child.specs[0];
    assert.ok(spec, 'the child was spawned');
    assert.equal(spec.cwd, join(w.lanternDir, 'worktrees', sessionId));
    assert.notEqual(spec.cwd, w.repo, 'never in the operator checkout');
    assert.match(git(w.remote, ['branch']), /lantern\/fix-parser/);

    // Blocked below the prompt: the git layer refused both.
    assert.match(child.pushToMain, /default branch 'main' refused/);
    assert.match(child.forcePush, /non-fast-forward .* refused/);
    assert.equal(git(w.remote, ['log', '--format=%s', 'main']).trim(), 'init');
    assert.equal(
      git(w.remote, ['log', '--format=%s', 'lantern/fix-parser', '-1']).trim(),
      'fix parser',
    );
    // …and by the tool layer: the flags forbid the same pushes.
    assert.ok(spec.disallowedTools.includes('Bash(git push origin main*)'));
    assert.ok(spec.disallowedTools.includes('Bash(git push --force*)'));
    assert.ok(!spec.allowedTools.includes('Bash(*)'));

    // Ticket to in_review, worktree gone, operator checkout untouched.
    assert.equal(getSession(w.db, sessionId)?.status, 'done');
    assert.equal(getTicket(w.db, ticketId)?.status, 'in_review');
    assert.ok(!existsSync(spec.cwd), 'worktree removed');
    assert.equal(git(w.repo, ['status', '--porcelain']).trim(), '');
    assert.match(git(w.repo, ['show', 'HEAD:parser.ts']), /fixed = false/);
  } finally {
    w.cleanup();
  }
});

test('the concurrency ceiling holds under a queue of 20 tickets', async () => {
  const w = world();
  try {
    w.db.prepare('UPDATE agents SET max_children = 3 WHERE id = ?').run(w.agent.id);
    const agent = { ...w.agent, max_children: 3 };
    for (let i = 0; i < 20; i++) {
      const r = w.tool('staff_ticket', { ticket_id: w.fileBug(`Bug ${i}`), tier: 'read_only' });
      assert.equal(r.error, false, r.text);
    }
    for (let pulse = 0; pulse < 3; pulse++) {
      await reapSessions(w.db, agent, w.lanternDir, w.pulse(), busy);
    }
    const running = (
      w.db.prepare(`SELECT count(*) AS n FROM sessions WHERE status = 'running'`).get() as {
        n: number;
      }
    ).n;
    assert.equal(running, 3);
  } finally {
    w.cleanup();
  }
});

test('a release request blocks until approved in `lantern inbox`, and only then starts', async () => {
  const w = world();
  try {
    const ticketId = w.fileBug('Cut 2.0');
    const refused = w.tool('staff_ticket', { ticket_id: ticketId, tier: 'release' });
    assert.equal(refused.error, true);
    assert.match(refused.text, /release_requires_approval/);

    // "Cannot be started any other way": a row inserted behind the tool's back
    // is still not spawned by reap.
    w.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, ticket_id, tier) VALUES ('sneaky', ?, ?, 'release')`,
      )
      .run(w.agent.id, ticketId);
    const child = new ChildSim();
    await reapSessions(w.db, w.agent, w.lanternDir, w.pulse(), child);
    assert.equal(child.specs.length, 0);
    assert.equal(getSession(w.db, 'sneaky')?.status, 'starting');
    w.db.prepare(`DELETE FROM sessions WHERE id = 'sneaky'`).run();

    const esc = JSON.parse(
      w.tool('escalate', { severity: 'blocking', question: 'Ship 2.0?', ticket_id: ticketId }).text,
    ) as { id: number };
    // A plain answer unblocks but does not approve…
    run(['inbox', 'answer', String(esc.id), 'looks fine'], sink(), sink(), {
      lanternDir: w.lanternDir,
    });
    assert.match(
      w.tool('staff_ticket', { ticket_id: ticketId, tier: 'release' }).text,
      /release_requires_approval/,
    );
    // …only `lantern inbox approve` does.
    const approval = JSON.parse(
      w.tool('escalate', { severity: 'decide', question: 'Approve 2.0?', ticket_id: ticketId })
        .text,
    ) as { id: number };
    const code = run(['inbox', 'approve', String(approval.id)], sink(), sink(), {
      lanternDir: w.lanternDir,
    });
    assert.equal(code, 0);

    const allowed = w.tool('staff_ticket', { ticket_id: ticketId, tier: 'release' });
    assert.equal(allowed.error, false, allowed.text);
    await reapSessions(w.db, w.agent, w.lanternDir, w.pulse(), child);
    assert.equal(child.specs.length, 1, 'approved release starts on the next reap');
  } finally {
    w.cleanup();
  }
});

// ── the daemon opens a draft PR with `gh` ──────────────────────────────

/** A child that only commits — pushing and the PR are the daemon's job. */
class CommitOnlyChild implements HarnessAdapter {
  specs: SessionSpec[] = [];
  async run(spec: SessionSpec) {
    this.specs.push(spec);
    writeFileSync(join(spec.cwd, 'parser.ts'), 'export const fixed = true;\n');
    git(spec.cwd, ['commit', '-qam', 'fix parser'], spec.env ?? {});
    return { id: 'c' };
  }
  poll = new ChildSim().poll;
  async interrupt() {}
  async kill() {}
}

/** Put a fake `gh` first on PATH for the duration of fn. It logs its args and cwd. */
async function withFakeGh<T>(dir: string, script: string, fn: (log: string) => Promise<T>) {
  const bin = join(dir, 'gh-bin');
  const log = join(dir, 'gh.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "cwd=$(pwd) args=$*" >> '${log}'\n${script}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await fn(log);
  } finally {
    process.env.PATH = saved;
  }
}

/**
 * Make `origin` a GitHub URL whose pushes still land in the local bare repo
 * (git's pushInsteadOf), so the daemon takes the GitHub path.
 */
function asGitHub(w: ReturnType<typeof world>) {
  const url = 'https://github.com/o/r.git';
  git(w.repo, ['remote', 'set-url', 'origin', url]);
  git(w.repo, ['config', `url.${w.remote}.pushInsteadOf`, url]);
}

async function staffAndFinish(w: ReturnType<typeof world>) {
  const ticketId = w.fileBug('Parser drops trailing field');
  const staffed = w.tool('staff_ticket', {
    ticket_id: ticketId,
    tier: 'write_branch',
    label: 'fix-parser',
  });
  const sessionId = (JSON.parse(staffed.text) as { session_id: string }).session_id;
  const child = new CommitOnlyChild();
  await reapSessions(w.db, w.agent, w.lanternDir, w.pulse(), child);
  // push + gh run synchronously inside the async completion; let it settle
  for (let i = 0; i < 50 && getSession(w.db, sessionId)?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { ticketId, sessionId, child };
}

test("a finished write child's branch is pushed and a draft PR opened with gh", async () => {
  const w = world();
  asGitHub(w);
  try {
    await withFakeGh(w.dir, "echo 'https://github.example/o/r/pull/7'", async (log) => {
      const { ticketId, sessionId, child } = await staffAndFinish(w);
      const branch = `lantern/fix-parser-${sessionId.slice(0, 8)}`;

      assert.match(
        git(w.remote, ['branch']),
        new RegExp(branch.replace('/', '\\/')),
        'daemon pushed the branch',
      );
      const call = readFileSync(log, 'utf8');
      assert.match(call, /args=pr create --draft --head lantern\/fix-parser-/);
      assert.match(call, new RegExp(`--title #${ticketId} Parser drops trailing field`));
      // match the suffix: macOS reports /var as /private/var from inside the shell
      assert.match(call, new RegExp(`cwd=\\S*/worktrees/${sessionId} `), 'gh ran in the worktree');

      const ticket = getTicket(w.db, ticketId);
      assert.equal(ticket?.pr_url, 'https://github.example/o/r/pull/7');
      assert.equal(ticket?.branch, branch);
      assert.equal(ticket?.status, 'in_review');
      assert.ok(!existsSync(child.specs[0]?.cwd ?? ''), 'worktree still cleaned up');
    });
  } finally {
    w.cleanup();
  }
});

test('if gh fails the ticket is blocked with the reason and the branch kept', async () => {
  const w = world();
  asGitHub(w);
  try {
    await withFakeGh(w.dir, "echo 'gh: not logged in' >&2; exit 1", async () => {
      const { ticketId, sessionId } = await staffAndFinish(w);
      const ticket = getTicket(w.db, ticketId);
      assert.equal(ticket?.status, 'blocked');
      assert.equal(ticket?.pr_url, null);
      const events = w.db
        .prepare(`SELECT event, payload FROM ticket_events WHERE ticket_id = ? AND event = 'error'`)
        .all(ticketId) as { payload: string }[];
      assert.ok(events.some((e) => /not logged in/.test(e.payload)));
      assert.match(
        git(w.repo, ['branch']),
        new RegExp(`lantern/fix-parser-${sessionId.slice(0, 8)}`),
      );
    });
  } finally {
    w.cleanup();
  }
});

// ── without GitHub, the pushed branch is what goes to review ─────

test('a local remote — branch pushed, no PR attempted, ticket in_review with a branch_pushed event', async () => {
  const w = world();
  try {
    await withFakeGh(w.dir, "echo 'https://github.example/o/r/pull/9'", async (log) => {
      const { ticketId, sessionId } = await staffAndFinish(w);
      const branch = `lantern/fix-parser-${sessionId.slice(0, 8)}`;
      assert.match(git(w.remote, ['branch']), new RegExp(branch.replace('/', '\\/')), 'pushed');
      assert.ok(!existsSync(log), 'gh was never run for a non-GitHub remote');
      const ticket = getTicket(w.db, ticketId);
      assert.equal(ticket?.status, 'in_review');
      assert.equal(ticket?.branch, branch);
      assert.equal(ticket?.pr_url, null);
      const ev = w.db
        .prepare(
          `SELECT payload FROM ticket_events WHERE ticket_id = ? AND event = 'branch_pushed'`,
        )
        .get(ticketId) as { payload: string } | undefined;
      assert.ok(ev, 'a branch_pushed event');
      const p = JSON.parse(ev.payload) as { branch: string; review: string };
      assert.equal(p.branch, branch);
      assert.equal(p.review, `git diff main...${branch}`);
    });
  } finally {
    w.cleanup();
  }
});

test('GitHub without gh on PATH — the branch still goes to review', async () => {
  const w = world();
  asGitHub(w);
  const saved = process.env.PATH;
  // git, sh and the coreutils the push hook needs — and no gh.
  process.env.PATH = '/usr/bin:/bin';
  try {
    const { ticketId } = await staffAndFinish(w);
    const ticket = getTicket(w.db, ticketId);
    assert.equal(ticket?.status, 'in_review');
    assert.equal(ticket?.pr_url, null);
    const ev = w.db
      .prepare(`SELECT payload FROM ticket_events WHERE ticket_id = ? AND event = 'branch_pushed'`)
      .get(ticketId) as { payload: string } | undefined;
    assert.match(ev?.payload ?? '', /gh is not installed/);
  } finally {
    process.env.PATH = saved;
    w.cleanup();
  }
});

test('a refused push still blocks, with the reason', async () => {
  const w = world();
  try {
    rmSync(w.remote, { recursive: true, force: true }); // the remote is gone: the push fails
    const { ticketId } = await staffAndFinish(w);
    assert.equal(getTicket(w.db, ticketId)?.status, 'blocked');
    const events = w.db
      .prepare(`SELECT payload FROM ticket_events WHERE ticket_id = ? AND event = 'error'`)
      .all(ticketId) as { payload: string }[];
    assert.ok(
      events.some((e) => /branch not pushed/.test(e.payload)),
      JSON.stringify(events),
    );
  } finally {
    w.cleanup();
  }
});

// ── the release path ────────────────────────────────────────────────────

/** A release child: commits, tags its HEAD, and tries (and fails) to reach main. */
class ReleaseChild implements HarnessAdapter {
  specs: SessionSpec[] = [];
  pushToMain = '';
  tag: string;
  constructor(tag = 'v1.2.0') {
    this.tag = tag;
  }
  async run(spec: SessionSpec) {
    this.specs.push(spec);
    const env = spec.env ?? {};
    writeFileSync(join(spec.cwd, 'VERSION'), '1.2.0\n');
    git(spec.cwd, ['add', '.'], env);
    git(spec.cwd, ['commit', '-qm', 'release 1.2.0'], env);
    git(spec.cwd, ['tag', '-a', this.tag, '-m', `release ${this.tag}`], env);
    try {
      git(spec.cwd, ['push', '-q', 'origin', 'HEAD:main'], env);
    } catch (e) {
      this.pushToMain = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    return { id: 'release-child' };
  }
  poll = new ChildSim().poll;
  async interrupt() {}
  async kill() {}
}

/** File a release ticket, approve it in the inbox as a human would, staff it. */
async function release(w: ReturnType<typeof world>, child: ReleaseChild, approve = true) {
  const ticketId = (
    JSON.parse(
      w.tool('tickets_create', { kind: 'release', title: 'Cut 1.2.0', body: 'b', origin: 'human' })
        .text,
    ) as { id: number }
  ).id;
  if (approve) {
    const esc = JSON.parse(
      w.tool('escalate', {
        ticket_id: ticketId,
        severity: 'blocking',
        question: 'Release 1.2.0?',
      }).text,
    ) as { escalation_id?: number; id?: number };
    const escId = esc.escalation_id ?? esc.id;
    assert.equal(
      run(['inbox', 'approve', String(escId)], sink(), sink(), { lanternDir: w.lanternDir }),
      0,
    );
  }
  const staffed = w.tool('staff_ticket', {
    ticket_id: ticketId,
    tier: 'release',
    label: 'release',
  });
  if (staffed.error) return { ticketId, staffed, sessionId: null };
  const sessionId = (JSON.parse(staffed.text) as { session_id: string }).session_id;
  await reapSessions(w.db, w.agent, w.lanternDir, w.pulse(), child);
  for (let i = 0; i < 50 && getSession(w.db, sessionId)?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { ticketId, staffed, sessionId };
}

test('an approved release child tags its branch; the daemon pushes branch and tag; main untouched', async () => {
  const w = world();
  try {
    const child = new ReleaseChild();
    const { ticketId, sessionId } = await release(w, child);
    assert.ok(sessionId, 'staffed after approval');
    const branch = `lantern/release-${(sessionId as string).slice(0, 8)}`;
    assert.match(git(w.remote, ['tag']), /v1\.2\.0/, 'the tag reached the remote');
    assert.equal(
      git(w.remote, ['rev-list', '-n', '1', 'v1.2.0']).trim(),
      git(w.remote, ['rev-parse', branch]).trim(),
      'the tag points at the release branch head',
    );
    assert.equal(git(w.remote, ['log', '--format=%s', 'main']).trim(), 'init', 'main untouched');
    assert.match(child.pushToMain, /default branch 'main' refused/);
    assert.ok(
      !child.specs[0]?.allowedTools.some((t) => t.startsWith('Bash(git push')),
      'the child cannot push',
    );
    assert.equal(getTicket(w.db, ticketId)?.status, 'in_review');
    const ev = w.db
      .prepare(`SELECT payload FROM ticket_events WHERE ticket_id = ? AND event = 'tag_pushed'`)
      .get(ticketId) as { payload: string } | undefined;
    assert.match(ev?.payload ?? '', /v1\.2\.0/);
  } finally {
    w.cleanup();
  }
});

test('without an approved escalation a release child is never staffed', async () => {
  const w = world();
  try {
    const child = new ReleaseChild();
    const { staffed } = await release(w, child, false);
    assert.equal(staffed.error, true);
    assert.match(staffed.text, /release_requires_approval/);
    assert.equal(child.specs.length, 0);
    assert.doesNotMatch(git(w.remote, ['tag']), /v1\.2\.0/);
  } finally {
    w.cleanup();
  }
});

test('a tag that already exists on the remote is never moved', async () => {
  const w = world();
  try {
    git(w.repo, ['tag', '-a', 'v1.2.0', '-m', 'the real 1.2.0']);
    git(w.repo, ['push', '-q', 'origin', 'refs/tags/v1.2.0']);
    git(w.repo, ['tag', '-d', 'v1.2.0']); // someone else's release: on the remote, not here
    const before = git(w.remote, ['rev-list', '-n', '1', 'v1.2.0']).trim();
    const child = new ReleaseChild(); // tags v1.2.0 again, on its own commit
    const { ticketId } = await release(w, child);
    assert.equal(git(w.remote, ['rev-list', '-n', '1', 'v1.2.0']).trim(), before, 'unchanged');
    assert.equal(getTicket(w.db, ticketId)?.status, 'blocked');
    const events = w.db
      .prepare(`SELECT payload FROM ticket_events WHERE ticket_id = ? AND event = 'error'`)
      .all(ticketId) as { payload: string }[];
    assert.ok(
      events.some((e) => /tag not pushed/.test(e.payload)),
      JSON.stringify(events),
    );
  } finally {
    w.cleanup();
  }
});

test('the push guard refuses to move or delete a tag on the remote', () => {
  const w = world();
  try {
    git(w.repo, ['tag', 'v9', 'HEAD']);
    git(w.repo, ['push', '-q', 'origin', 'refs/tags/v9']);
    writeFileSync(join(w.repo, 'x'), 'x');
    git(w.repo, ['add', '.']);
    git(w.repo, ['commit', '-qm', 'next']);
    git(w.repo, ['tag', '-f', 'v9', 'HEAD']);
    const guardDir = join(w.dir, 'guard');
    const env = installPushGuard(w.repo, guardDir);
    assert.throws(
      () => git(w.repo, ['push', '-q', '--force', 'origin', 'refs/tags/v9'], env),
      /tag .*refused/,
    );
    assert.throws(() => git(w.repo, ['push', '-q', 'origin', ':refs/tags/v9'], env), /refused/);
  } finally {
    w.cleanup();
  }
});
