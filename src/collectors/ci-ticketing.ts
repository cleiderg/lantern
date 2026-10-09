/**
 * `ci.watch` ticketing: what a recorded run means for the ledger.
 *
 *  - failing — a test that failed (or errored) in two consecutive runs that
 *    ran it and never passed on this commit → one bug ticket, p1;
 *  - flaky — a test that passed and failed on the same commit, or passed only
 *    after a Surefire rerun → one ticket, p2;
 *  - broken — two runs in a row with no report (or killed at the deadline) →
 *    one "build broken" ticket, p1;
 *  - recovered — an open failing or broken ticket whose test (or build) is
 *    green again gets one `recovered` event; a person or the agent closes it.
 *
 * One fingerprint per (kind, test). Whether to file is store/dedupe.ts's
 * `shouldFile` — the noise rules as the log scan applies them (open, suppressed unless the
 * rate spiked, or tracked on an open ticket it duplicates).
 * Every ticket arrives needs_triage. Messages are collected content.
 */

import type Database from 'better-sqlite3';
import { type CiRun, runResults, testHistory } from '../store/ci.ts';
import { shouldFile } from '../store/dedupe.ts';
import { writeEvent } from '../store/events.ts';
import { computeFingerprint, recordObservation } from '../store/observations.ts';
import { createTicket, getTicketEvents } from '../store/tickets.ts';
import type { Agent } from '../types.ts';
import { TERMINAL_SQL } from '../types.ts';

type Db = Database.Database;
export type CiKind = 'failing' | 'flaky' | 'broken';

export type CiTicketing = {
  filed: Array<{ id: number; kind: CiKind; testId: string | null }>;
  recovered: number[];
};

const BUILD = '(build)';
const fingerprintOf = (kind: CiKind, testId: string) => computeFingerprint('ci', kind, testId);
const originRef = (kind: CiKind, testId: string) => `${kind}:${testId}`;

/** The run before this one, for this agent. */
function previousRun(db: Db, agentId: string, runId: number): CiRun | undefined {
  return db
    .prepare('SELECT * FROM ci_runs WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .get(agentId, runId) as CiRun | undefined;
}

/** This test's outcome in the latest earlier run that ran it. */
function previousOutcome(db: Db, agentId: string, runId: number, testId: string): string | null {
  const row = db
    .prepare(
      `SELECT r.outcome FROM test_results r JOIN ci_runs c ON c.id = r.run_id
       WHERE c.agent_id = ? AND c.id < ? AND r.test_id = ? ORDER BY c.id DESC LIMIT 1`,
    )
    .get(agentId, runId, testId) as { outcome: string } | undefined;
  return row?.outcome ?? null;
}

/** The most recent failure message for a test on a commit. */
function lastFailure(db: Db, agentId: string, testId: string, sha: string): string {
  const row = db
    .prepare(
      `SELECT r.message FROM test_results r JOIN ci_runs c ON c.id = r.run_id
       WHERE c.agent_id = ? AND c.commit_sha = ? AND r.test_id = ? AND r.outcome IN ('fail','error')
       ORDER BY c.id DESC LIMIT 1`,
    )
    .get(agentId, sha, testId) as { message: string | null } | undefined;
  return row?.message ?? '';
}

export function ticketCiRun(
  db: Db,
  agent: Agent,
  pulseId: number | null,
  runId: number,
): CiTicketing {
  const run = db.prepare('SELECT * FROM ci_runs WHERE id = ?').get(runId) as CiRun;
  const results = runResults(db, runId);
  const out: CiTicketing = { filed: [], recovered: [] };
  const sha8 = run.commit_sha.slice(0, 8);

  const file = (kind: CiKind, testId: string, title: string, body: string) => {
    const fingerprint = fingerprintOf(kind, testId);
    const obs = recordObservation(db, {
      fingerprint,
      source: 'ci',
      sample: `${kind} ${testId}`,
      severity: kind === 'flaky' ? 'warning' : 'crash',
      pulseId,
    });
    // The noise rules in one place: open, suppressed, or tracked on another ticket.
    if (!shouldFile(db, fingerprint, obs).file) return;
    const id = createTicket(
      db,
      {
        kind: 'bug',
        title,
        body,
        origin: 'collector:ci',
        origin_ref: originRef(kind, testId),
        fingerprint,
        priority: kind === 'flaky' ? 'p2' : 'p1',
        needs_triage: true,
        agent_id: agent.id,
        opened_pulse: pulseId,
      },
      { actor: agent.display_name, pulse_id: pulseId },
    );
    out.filed.push({ id, kind, testId: testId === BUILD ? null : testId });
  };

  // ── a broken build ──────────────────────────────────────────────────────────
  const brokenish = (s: string | undefined) => s === 'broken' || s === 'timeout';
  if (brokenish(run.status)) {
    if (brokenish(previousRun(db, agent.id, runId)?.status)) {
      file(
        'broken',
        BUILD,
        '[ci] Build broken on the default branch',
        `The test command produced no test report in two runs in a row (latest: run #${run.id}, ${run.status}, commit \`${sha8}\`).\n\n` +
          `**Output (last lines):**\n\`\`\`\n${run.detail ?? ''}\n\`\`\``,
      );
    }
  } else {
    // ── failing and flaky tests ─────────────────────────────────────────────
    for (const r of results) {
      const bad = r.outcome === 'fail' || r.outcome === 'error';
      if (bad) {
        const onCommit = testHistory(db, agent.id, r.test_id, run.commit_sha);
        if (onCommit.pass > 0) {
          file(
            'flaky',
            r.test_id,
            `[ci] Flaky: ${r.test_id}`,
            `Passed and failed on the same commit \`${sha8}\`: ${onCommit.pass} pass, ${onCommit.fail + onCommit.error} fail across ${onCommit.runs} runs (latest run #${run.id}).\n\n` +
              `**Latest failure:**\n\`\`\`\n${r.message ?? ''}\n\`\`\``,
          );
        } else {
          const prev = previousOutcome(db, agent.id, runId, r.test_id);
          if (prev === 'fail' || prev === 'error') {
            file(
              'failing',
              r.test_id,
              `[ci] Failing: ${r.test_id}`,
              `Failed in two consecutive runs, the latest on commit \`${sha8}\` (run #${run.id}).\n\n` +
                `**Failure:**\n\`\`\`\n${r.message ?? ''}\n\`\`\``,
            );
          }
        }
      } else if (r.outcome === 'pass' && !r.flaky) {
        // A pass after a failure on the same commit: the same flip, seen from
        // the other side (the PetClinic trial's flaky test failed first).
        const onCommit = testHistory(db, agent.id, r.test_id, run.commit_sha);
        if (onCommit.fail + onCommit.error > 0) {
          file(
            'flaky',
            r.test_id,
            `[ci] Flaky: ${r.test_id}`,
            `Passed and failed on the same commit \`${sha8}\`: ${onCommit.pass} pass, ${onCommit.fail + onCommit.error} fail across ${onCommit.runs} runs (latest run #${run.id}).\n\n` +
              `**Last failure:**\n\`\`\`\n${lastFailure(db, agent.id, r.test_id, run.commit_sha)}\n\`\`\``,
          );
        }
      } else if (r.outcome === 'pass' && r.flaky) {
        file(
          'flaky',
          r.test_id,
          `[ci] Flaky: ${r.test_id}`,
          `Passed on commit \`${sha8}\` only after the runner retried it (run #${run.id}).\n\n` +
            `**The failure before the retry:**\n\`\`\`\n${r.message ?? ''}\n\`\`\``,
        );
      }
    }
  }

  // ── recovery: open failing / broken tickets whose test or build is green ──
  const passing = new Set(results.filter((r) => r.outcome === 'pass').map((r) => r.test_id));
  const open = db
    .prepare(
      `SELECT id, origin_ref FROM tickets
       WHERE origin = 'collector:ci' AND agent_id = ? AND status NOT IN ${TERMINAL_SQL}`,
    )
    .all(agent.id) as { id: number; origin_ref: string | null }[];
  for (const t of open) {
    const ref = t.origin_ref ?? '';
    const green =
      (ref === originRef('broken', BUILD) && !brokenish(run.status)) ||
      (ref.startsWith('failing:') && passing.has(ref.slice('failing:'.length)));
    if (!green) continue;
    if (getTicketEvents(db, t.id).at(-1)?.event === 'recovered') continue;
    writeEvent(db, {
      ticket_id: t.id,
      actor: agent.display_name,
      pulse_id: pulseId,
      event: 'recovered',
      payload: { run: run.id, commit: run.commit_sha },
    });
    out.recovered.push(t.id);
  }
  return out;
}
