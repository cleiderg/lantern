/**
 * `ci.watch`: run the agent's test command on the default branch's head,
 * in a scratch worktree, and record what the JUnit reports say.
 *
 * The run happens at most every `every`; a pulse in between records `skipped`
 * with when it is next due — never `clean`, because nothing was checked. The
 * command runs in a detached worktree under LANTERN_DIR, never in the operator's
 * checkout, in its own process group so a timeout kills the whole tree (a
 * Maven run starts a JVM). The worktree is removed whatever happens.
 *
 * The collector spends no Claude tokens. What a run means for the ledger is
 * ci-ticketing.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CiWatchConfig } from '../agent-config.ts';
import { git } from '../git.ts';
import { runWithDeadline } from '../proc.ts';
import { type CiRun, lastRun, recordRun } from '../store/ci.ts';
import { writePulseFinding } from '../store/pulses.ts';
import { parseStoredTime } from '../time.ts';
import type { Agent } from '../types.ts';
import { defaultBranch } from '../worktree.ts';
import { ticketCiRun } from './ci-ticketing.ts';
import { parseJUnit, type TestResult } from './junit.ts';

export type CiExec = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number | null; timedOut: boolean; output: string }>;

export type CiWatchResult =
  | { outcome: 'ran'; run: CiRun }
  | { outcome: 'not_due'; dueAt: string; last: CiRun }
  | { outcome: 'error'; error: string };

const OUTPUT_TAIL = 4000;

/** Spawn in its own process group; at the deadline SIGTERM the group, then SIGKILL. */
export const execInGroup: CiExec = async (argv, cwd, timeoutMs) => {
  const r = await runWithDeadline(argv, { cwd, timeoutMs, group: true, tail: OUTPUT_TAIL });
  return {
    code: r.code,
    timedOut: r.timedOut,
    output: r.error ? `${r.output}\n${r.error}` : r.output,
  };
};

/** Report files matching the configured paths (`*` in the file name only). */
function findReports(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const slash = p.lastIndexOf('/');
    const dir = join(root, slash < 0 ? '.' : p.slice(0, slash));
    const name = slash < 0 ? p : p.slice(slash + 1);
    if (!existsSync(dir)) continue;
    const re = new RegExp(
      `^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    for (const f of readdirSync(dir).sort()) if (re.test(f)) out.push(join(dir, f));
  }
  return out;
}

const fmtTime = (iso: string) => iso.slice(11, 16);

export async function runCiWatch(
  db: Database.Database,
  agent: Agent,
  pulseId: number,
  cfg: CiWatchConfig,
  opts: { lanternDir: string; now?: Date; exec?: CiExec },
): Promise<CiWatchResult> {
  const now = opts.now ?? new Date();
  const finding = (outcome: 'clean' | 'finding' | 'skipped' | 'error', detail: string) =>
    writePulseFinding(db, { pulseId, actionKey: 'ci.watch', outcome, detail });

  // Due? `every` is measured from the last run's start.
  const last = lastRun(db, agent.id);
  if (last) {
    const startedMs = parseStoredTime(last.started_at);
    const dueMs = startedMs + cfg.everySeconds * 1000;
    if (now.getTime() < dueMs) {
      const dueAt = new Date(dueMs).toISOString();
      finding(
        'skipped',
        `not due until ${fmtTime(dueAt)} UTC (every ${cfg.everySeconds / 60}m); last run: ${last.status} on ${last.commit_sha.slice(0, 8)}`,
      );
      return { outcome: 'not_due', dueAt, last };
    }
  }

  let sha: string;
  try {
    sha = git(agent.workdir, [
      'rev-parse',
      '--verify',
      `${defaultBranch(agent.workdir) ?? 'HEAD'}^{commit}`,
    ]);
  } catch (e) {
    const error = `could not resolve the default branch in ${agent.workdir}: ${(e as Error).message}`;
    finding('error', error);
    return { outcome: 'error', error };
  }

  const base = join(opts.lanternDir, 'ci-worktrees');
  mkdirSync(base, { recursive: true });
  const wt = join(base, `${agent.id}-${now.getTime()}`);
  const startedAt = now.toISOString();
  try {
    git(agent.workdir, ['worktree', 'add', '--detach', '-q', wt, sha]);
  } catch (e) {
    const error = `could not create a scratch worktree: ${(e as Error).message}`;
    finding('error', error);
    return { outcome: 'error', error };
  }

  try {
    const argv = cfg.command.split(/\s+/);
    const res = await (opts.exec ?? execInGroup)(argv, wt, cfg.timeoutSeconds * 1000);
    const results: TestResult[] = [];
    const parseErrors: string[] = [];
    for (const f of findReports(wt, cfg.reports)) {
      try {
        results.push(...parseJUnit(readFileSync(f, 'utf8')));
      } catch (e) {
        parseErrors.push(`${f.slice(wt.length + 1)}: ${(e as Error).message}`);
      }
    }
    const tail = res.output.trim().split('\n').slice(-20).join('\n');
    const detail = [
      res.timedOut ? `killed after ${cfg.timeoutSeconds}s` : `exit ${res.code}`,
      ...parseErrors,
      results.length === 0 && tail ? tail : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
    const runId = recordRun(db, {
      agentId: agent.id,
      pulseId,
      sha,
      exitCode: res.code,
      results: res.timedOut ? [] : results,
      detail,
      timedOut: res.timedOut,
      startedAt,
    });
    const run = lastRun(db, agent.id) as CiRun;
    const failed = results.filter((r) => r.outcome === 'fail' || r.outcome === 'error').length;
    // what the run means for the ledger — failing, flaky, broken, recovered.
    const t = ticketCiRun(db, agent, pulseId, runId);
    for (const f of t.filed) {
      writePulseFinding(db, {
        pulseId,
        actionKey: 'ci.watch',
        outcome: 'finding',
        detail: `#${f.id}: ${f.kind}${f.testId ? ` ${f.testId}` : ' build'} (run #${runId} on ${sha.slice(0, 8)})`,
        ticketId: f.id,
      });
    }
    const recovered = t.recovered.length
      ? `; recovered: ${t.recovered.map((id) => `#${id}`).join(', ')}`
      : '';
    if (t.filed.length === 0) {
      if (run.status === 'passed') {
        finding(
          'clean',
          `run #${runId} on ${sha.slice(0, 8)}: ${results.length} tests passed${recovered}`,
        );
      } else if (run.status === 'failed') {
        finding(
          'finding',
          `run #${runId} on ${sha.slice(0, 8)}: ${failed} of ${results.length} tests failed — no new ticket (first sighting, or already tracked)${recovered}`,
        );
      } else {
        finding(
          'finding',
          `run #${runId} on ${sha.slice(0, 8)}: ${run.status} — ${detail.split('\n')[0]}${recovered}`,
        );
      }
    }
    return { outcome: 'ran', run: { ...run, id: runId } };
  } finally {
    try {
      git(agent.workdir, ['worktree', 'remove', '--force', wt]);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      try {
        git(agent.workdir, ['worktree', 'prune']);
      } catch {
        // best effort
      }
    }
  }
}
