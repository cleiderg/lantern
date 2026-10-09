/**
 * A fresh, throwaway Lantern for one ui:smoke scenario (every scenario
 * starts from this, so no check depends on what an earlier one left behind).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent } from '../../src/agent.ts';
import { ticketCiRun } from '../../src/collectors/ci-ticketing.ts';
import { type Db, openDb } from '../../src/db.ts';
import { initLantern } from '../../src/init.ts';
import { recordRun } from '../../src/store/ci.ts';
import { createEscalation } from '../../src/store/escalations.ts';
import { createRunningPulse, finishPulse, writePulseFinding } from '../../src/store/pulses.ts';
import { createSession } from '../../src/store/sessions.ts';
import { createTicket } from '../../src/store/tickets.ts';
import type { Agent } from '../../src/types.ts';

export const TRANSCRIPT_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/transcript.jsonl', import.meta.url),
);

export type World = {
  root: string;
  lanternDir: string;
  /** PATH for `lantern ui`: a fake `claude` and nothing else. */
  fakeBin: string;
  db: Db;
  agent: Agent;
  hostile: number;
  release: number;
  escalation: number;
  pulseId: number;
  skipId: number;
};

export function seedWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'lantern-ui-smoke-'));
  const lanternDir = join(root, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, root);
  const hostile = createTicket(
    db,
    {
      kind: 'bug',
      title: `<img src=x onerror="document.title='PWNED'"> Worker crashed`,
      body: '<script>document.title="PWNED"</script>',
      origin: 'collector:logs',
      needs_triage: true,
    },
    { actor: 'smoke' },
  );
  // an email triage queue with real evidence to show and act on.
  const triageMail = (title: string, message: string) =>
    createTicket(
      db,
      {
        kind: 'bug',
        title,
        body: `**From:** u@example.com\n**Date:** 2025-01-01\n**Thread:** (none)\n\n---\n\n${message}`,
        origin: 'collector:email',
        needs_triage: true,
      },
      { actor: 'smoke' },
    );
  triageMail('Export crashes', 'Steps to reproduce:\n1. Click export\nTypeError: x is undefined');
  triageMail('How do I set a base path?', 'Is there a way?');
  triageMail('[Feature] Matrix', 'It would be great to support Matrix.');
  const release = createTicket(
    db,
    { kind: 'release', title: 'Cut 2.0', body: 'ship it', origin: 'human', priority: 'p1' },
    { actor: 'smoke' },
  );
  const escalation = createEscalation(db, {
    agentId: agent.id,
    ticketId: release,
    severity: 'decide',
    question: 'Approve the 2.0 release?',
  });
  const pulseId = createRunningPulse(db, { agentId: agent.id, windowStart: 'a', windowEnd: 'b' });
  // A saved transcript for that pulse, from the synthetic fixture.
  mkdirSync(join(lanternDir, 'runs', String(pulseId)), { recursive: true });
  copyFileSync(TRANSCRIPT_FIXTURE, join(lanternDir, 'runs', String(pulseId), 'orchestrator.jsonl'));
  writePulseFinding(db, { pulseId, actionKey: 'logs.scan', outcome: 'finding', ticketId: hostile });
  finishPulse(db, pulseId, { status: 'acted', summary: 'filed one', costUsd: 0.12 });
  // a gate refusal, the agent's latest pulse.
  const skipId = createRunningPulse(db, { agentId: agent.id, windowStart: 'b', windowEnd: 'c' });
  finishPulse(db, skipId, { status: 'skipped', error: 'working tree is dirty' });
  createSession(db, {
    id: 'smoke-session-1',
    agentId: agent.id,
    tier: 'read_only',
    ticketId: release,
  });

  // a flaky test ci.watch saw — fail once, pass twice on one commit.
  for (const outcome of ['fail', 'pass', 'pass'] as const) {
    const runId = recordRun(db, {
      agentId: agent.id,
      pulseId: null,
      sha: 'abcdef1234567',
      exitCode: outcome === 'fail' ? 1 : 0,
      results: [
        {
          testId: 'Demo#halfTheTime',
          classname: 'Demo',
          name: 'halfTheTime',
          outcome,
          ms: 1,
          message: outcome === 'fail' ? 'expected: <true> but was: <false>' : '',
          flaky: false,
        },
      ],
    });
    ticketCiRun(db, agent, null, runId);
  }

  // A stand-in `claude` that answers only the Claude page's test turn and fails
  // anything else — so a daemon started from the page still never runs a turn.
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, 'claude'),
    `#!/bin/sh
case "$*" in
  --version) echo "9.9.9 (fake claude)" ;;
  *"Reply with exactly: OK"*) echo '{"type":"result","is_error":false,"result":"OK","total_cost_usd":0.011,"modelUsage":{"claude-opus-5-5":{}}}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, lanternDir, fakeBin, db, agent, hostile, release, escalation, pulseId, skipId };
}

/** A running child `smoke-live` whose transcript holds the fixture's first line; its path. */
export function addLiveSession(w: World): string {
  const first = readFileSync(TRANSCRIPT_FIXTURE, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('{'));
  const livePath = join(w.lanternDir, 'runs', String(w.pulseId), 'smoke-live.jsonl');
  writeFileSync(livePath, `${first}\n`);
  createSession(w.db, {
    id: 'smoke-live',
    agentId: w.agent.id,
    tier: 'read_only',
    ticketId: w.release,
  });
  w.db
    .prepare("UPDATE sessions SET status = 'running', transcript_path = ? WHERE id = 'smoke-live'")
    .run(livePath);
  return livePath;
}

/** Kill a daemon the page started (it is detached), close the store, remove the dir. */
export function disposeWorld(w: World): void {
  const pidPath = join(w.lanternDir, `${w.agent.id}.pid`);
  if (existsSync(pidPath)) {
    try {
      process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL');
    } catch {
      // already gone
    }
  }
  w.db.close();
  // Killed children can still be exiting (the daemon's log): retry, and never
  // let cleanup hide the results.
  try {
    rmSync(w.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.error(`ui:smoke: could not remove ${w.root}: ${e instanceof Error ? e.message : e}`);
  }
}
