/**
 * What the triage card shows for each collector's ticket — email, logs, ci —
 * built from the store. Collected text: the
 * page renders it with textContent (Law 8).
 */

import { bugEvidence } from '../../collectors/inbox-bugs.ts';
import type { Db } from '../../db.ts';
import { testHistory } from '../../store/ci.ts';
import type { Ticket } from '../../types.ts';

/**
 * Why a ticket was filed. Email: the classifier's own labelled signals,
 * recomputed from the message inside the ticket body (the shape inbox.bugs
 * writes: header lines, a rule, the message, then a prior-art line that is
 * not part of the message). Logs: how often and across how many pulses the
 * fingerprint was seen. Others: none.
 */
export function evidenceFor(db: Db, t: Ticket): unknown {
  if (t.origin === 'collector:email') {
    const start = t.body.indexOf('\n---\n\n');
    let message = start >= 0 ? t.body.slice(start + 6) : t.body;
    const prior = message.lastIndexOf('\n\n**Prior art:**');
    if (prior >= 0) message = message.slice(0, prior);
    return {
      kind: 'email',
      ...bugEvidence({ id: '', from: '', date: '', subject: t.title, body: message }),
    };
  }
  if (t.origin === 'collector:logs') {
    const o = t.fingerprint
      ? (db
          .prepare('SELECT occurrences, pulse_count FROM observations WHERE fingerprint = ?')
          .get(t.fingerprint) as { occurrences: number; pulse_count: number } | undefined)
      : undefined;
    return { kind: 'logs', occurrences: o?.occurrences ?? null, pulses: o?.pulse_count ?? null };
  }
  if (t.origin === 'collector:ci') return ciEvidence(db, t);
  return null;
}

/** what a ci.watch ticket rests on — the latest commit's pass/fail counts and failure. */
function ciEvidence(db: Db, t: Ticket): unknown {
  const ref = t.origin_ref ?? '';
  const colon = ref.indexOf(':');
  const ciKind = colon > 0 ? ref.slice(0, colon) : 'failing';
  const testId = colon > 0 ? ref.slice(colon + 1) : '';
  if (ciKind === 'broken') {
    const runs = db
      .prepare(
        `SELECT commit_sha, status, detail FROM ci_runs WHERE agent_id = ? ORDER BY id DESC LIMIT 5`,
      )
      .all(t.agent_id) as { commit_sha: string; status: string; detail: string | null }[];
    return {
      kind: 'ci',
      ciKind,
      testId: null,
      commit: runs[0]?.commit_sha.slice(0, 8) ?? null,
      runs: runs.length,
      broken: runs.filter((r) => r.status === 'broken' || r.status === 'timeout').length,
      lastFailure:
        (runs.find((r) => r.detail)?.detail ?? '')
          .split('\n')
          .find((l) => l.trim() && !/^exit /.test(l)) ?? '',
    };
  }
  const latest = db
    .prepare(
      `SELECT c.commit_sha FROM test_results r JOIN ci_runs c ON c.id = r.run_id
       WHERE c.agent_id = ? AND r.test_id = ? ORDER BY c.id DESC LIMIT 1`,
    )
    .get(t.agent_id, testId) as { commit_sha: string } | undefined;
  if (!latest)
    return { kind: 'ci', ciKind, testId, commit: null, runs: 0, pass: 0, fail: 0, lastFailure: '' };
  const tally = testHistory(db, t.agent_id as string, testId, latest.commit_sha);
  const failure = db
    .prepare(
      `SELECT r.message FROM test_results r JOIN ci_runs c ON c.id = r.run_id
       WHERE c.agent_id = ? AND r.test_id = ? AND r.outcome IN ('fail','error') ORDER BY c.id DESC LIMIT 1`,
    )
    .get(t.agent_id, testId) as { message: string | null } | undefined;
  return {
    kind: 'ci',
    ciKind,
    testId,
    commit: latest.commit_sha.slice(0, 8),
    runs: tally.runs,
    pass: tally.pass,
    fail: tally.fail + tally.error,
    lastFailure: (failure?.message ?? '').split('\n')[0]?.slice(0, 200) ?? '',
  };
}
