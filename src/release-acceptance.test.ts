/**
 * Release acceptance: a release-tier request blocks until approved in
 * `lantern inbox` and cannot be started any other way, and answering an
 * escalation unblocks the ticket on the next pulse.
 *
 * Walks the full human-in-the-loop path end to end: an orchestrator tries to
 * stage a release-tier session, is refused because the ticket has an open
 * blocking escalation, a human answers it through `lantern inbox`, and the same
 * staff_ticket call then succeeds — with `lantern status` reflecting the drop
 * in unanswered escalations throughout.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { run } from './cli.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { callTool } from './mcp/tools.ts';
import { createRunningPulse } from './store/pulses.ts';
import { createTicket } from './store/tickets.ts';

function sink() {
  const chunks: string[] = [];
  return {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join('');
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stream stub for run()
  } as any;
}

test('release-tier staffing blocks on an open escalation and unblocks once answered', {
  timeout: 10000,
}, () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-release-acceptance-'));
  try {
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    const agent = ensureDefaultAgent(db, lanternDir);
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-28T00:00:00.000Z',
      windowEnd: '2026-09-28T01:00:00.000Z',
    });
    const ticketId = createTicket(
      db,
      { kind: 'release', title: 'Cut v3.0.0', body: 'Tag and publish', origin: 'human' },
      { actor: 'test' },
    );

    const ctx = {
      lanternDir,
      agentId: agent.id,
      pulseId,
      sessionId: null,
      ticketId: null,
      tier: 'orchestrator' as const,
    };
    const eventCtx = { actor: agent.id, pulse_id: pulseId, session_id: null };

    // 1. The orchestrator raises a blocking escalation before attempting to staff.
    const escalated = callTool(db, ctx, eventCtx, 'escalate', {
      severity: 'blocking',
      question: 'OK to cut v3.0.0 now?',
      ticket_id: ticketId,
    });
    const escalationId = (JSON.parse(escalated.content[0]?.text ?? '{}') as { id: number }).id;

    // lantern status must show it as an unanswered escalation.
    const statusBefore = sink();
    run(['status'], statusBefore, sink(), { lanternDir });
    assert.match(statusBefore.text, /unanswered escalations: 1/);

    // 2. staff_ticket is refused — cannot be started any other way.
    const refused = callTool(db, ctx, eventCtx, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? '', /blocked_by_escalation/);

    const sessionsAfterRefusal = db.prepare('SELECT count(*) as n FROM sessions').get() as {
      n: number;
    };
    assert.equal(sessionsAfterRefusal.n, 0, 'a refused staff_ticket must not create a session row');

    // 3. A human answers it through `lantern inbox`.
    const answered = run(
      ['inbox', 'answer', String(escalationId), 'yes,', 'proceed', 'with', 'the', 'release'],
      sink(),
      sink(),
      { lanternDir },
    );
    assert.equal(answered, 0);

    const statusAfter = sink();
    run(['status'], statusAfter, sink(), { lanternDir });
    assert.match(statusAfter.text, /unanswered escalations: 0/);

    // 4. Answering unblocked the ticket — but a release also
    //    needs an explicit approve verdict, so it is still refused…
    const unblockedNotApproved = callTool(db, ctx, eventCtx, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.match(unblockedNotApproved.content[0]?.text ?? '', /release_requires_approval/);
    assert.doesNotMatch(unblockedNotApproved.content[0]?.text ?? '', /blocked_by_escalation/);

    // 5. …until the human approves in `lantern inbox`.
    const approval = callTool(db, ctx, eventCtx, 'escalate', {
      severity: 'decide',
      question: 'Approve the release?',
      ticket_id: ticketId,
    });
    const approvalId = (JSON.parse(approval.content[0]?.text ?? '{}') as { id: number }).id;
    assert.equal(run(['inbox', 'approve', String(approvalId)], sink(), sink(), { lanternDir }), 0);

    const allowed = callTool(db, ctx, eventCtx, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.equal(allowed.isError, undefined, allowed.content[0]?.text ?? '');
    const body = JSON.parse(allowed.content[0]?.text ?? '{}') as { status: string };
    assert.equal(body.status, 'queued');

    db.close();
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});
