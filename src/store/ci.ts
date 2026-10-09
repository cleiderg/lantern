/**
 * The `ci.watch` store (migration 005): one row per run of the agent's test
 * command, one per test result. The history a flaky test shows up in — a pass
 * and a fail on the same commit — lives here, not in `observations`.
 */

import type Database from 'better-sqlite3';
import type { TestResult } from '../types.ts';

type Db = Database.Database;

export type CiRunStatus = 'passed' | 'failed' | 'broken' | 'timeout';

export type CiRun = {
  id: number;
  agent_id: string;
  pulse_id: number | null;
  commit_sha: string;
  started_at: string;
  ended_at: string | null;
  status: CiRunStatus;
  exit_code: number | null;
  tests: number;
  detail: string | null;
};

export type Tally = { runs: number; pass: number; fail: number; error: number; skip: number };

/**
 * Record one run and its results atomically. The status follows the results:
 * any fail or error → failed; none and no report → broken (or timeout); else passed.
 */
export function recordRun(
  db: Db,
  input: {
    agentId: string;
    pulseId: number | null;
    sha: string;
    exitCode: number | null;
    results: TestResult[];
    detail?: string;
    timedOut?: boolean;
    startedAt?: string;
  },
): number {
  const status: CiRunStatus = input.timedOut
    ? 'timeout'
    : input.results.length === 0
      ? input.exitCode === 0
        ? 'passed'
        : 'broken'
      : input.results.some((r) => r.outcome === 'fail' || r.outcome === 'error')
        ? 'failed'
        : 'passed';
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO ci_runs (agent_id, pulse_id, commit_sha, started_at, ended_at, status, exit_code, tests, detail)
           VALUES (?, ?, ?, coalesce(?, datetime('now')), datetime('now'), ?, ?, ?, ?)`,
        )
        .run(
          input.agentId,
          input.pulseId,
          input.sha,
          input.startedAt ?? null,
          status,
          input.exitCode,
          input.results.length,
          input.detail ?? null,
        ).lastInsertRowid,
    );
    const ins = db.prepare(
      `INSERT OR REPLACE INTO test_results (run_id, test_id, outcome, flaky, ms, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of input.results) {
      ins.run(id, r.testId, r.outcome, r.flaky ? 1 : 0, r.ms, r.message || null);
    }
    return id;
  })();
}

/** The agent's most recent run, or undefined. */
export function lastRun(db: Db, agentId: string): CiRun | undefined {
  return db
    .prepare('SELECT * FROM ci_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1')
    .get(agentId) as CiRun | undefined;
}

export function runResults(
  db: Db,
  runId: number,
): Array<{ test_id: string; outcome: string; flaky: number; ms: number; message: string | null }> {
  return db
    .prepare(
      'SELECT test_id, outcome, flaky, ms, message FROM test_results WHERE run_id = ? ORDER BY test_id',
    )
    .all(runId) as Array<{
    test_id: string;
    outcome: string;
    flaky: number;
    ms: number;
    message: string | null;
  }>;
}

const empty = (): Tally => ({ runs: 0, pass: 0, fail: 0, error: 0, skip: 0 });

/** One test's outcomes on one commit, across the agent's runs. */
export function testHistory(db: Db, agentId: string, testId: string, sha: string): Tally {
  const t = empty();
  const rows = db
    .prepare(
      `SELECT r.outcome, count(*) AS n FROM test_results r JOIN ci_runs c ON c.id = r.run_id
       WHERE c.agent_id = ? AND c.commit_sha = ? AND r.test_id = ? GROUP BY r.outcome`,
    )
    .all(agentId, sha, testId) as { outcome: keyof Omit<Tally, 'runs'>; n: number }[];
  for (const row of rows) {
    t[row.outcome] = row.n;
    t.runs += row.n;
  }
  return t;
}
