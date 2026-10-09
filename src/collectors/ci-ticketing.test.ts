import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { recordRun } from '../store/ci.ts';
import { createLink } from '../store/links.ts';
import { suppressFingerprint } from '../store/observations.ts';
import { closeTicket, createTicket, getTicketEvents, listTickets } from '../store/tickets.ts';
import { ticketCiRun } from './ci-ticketing.ts';
import type { TestOutcome, TestResult } from './junit.ts';

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-ci-ticketing-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, dir);
  const res = (testId: string, outcome: TestOutcome, flaky = false): TestResult => ({
    testId,
    classname: testId.split('#')[0] as string,
    name: testId.split('#')[1] as string,
    outcome,
    ms: 3,
    message: outcome === 'pass' ? '' : 'Status expected:<404> but was:<500>',
    flaky,
  });
  /** Record a run and apply the rules to it; returns the tickets filed by it. */
  const run = (
    sha: string,
    results: TestResult[],
    exitCode = results.some((r) => r.outcome !== 'pass') ? 1 : 0,
  ) => {
    const runId = recordRun(db, {
      agentId: agent.id,
      pulseId: null,
      sha,
      exitCode,
      results,
      detail: exitCode && !results.length ? 'error: cannot find symbol' : '',
    });
    return ticketCiRun(db, agent, null, runId);
  };
  const ciTickets = () => listTickets(db, {}).filter((t) => t.origin === 'collector:ci');
  return {
    db,
    agent,
    res,
    run,
    ciTickets,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a test failing in two consecutive runs files one failing ticket; a third run files nothing new', () => {
  const w = world();
  try {
    assert.deepEqual(
      w.run('c1', [w.res('Pet#notFound', 'fail')]).filed,
      [],
      'one failure is not yet a ticket',
    );
    const second = w.run('c2', [w.res('Pet#notFound', 'fail')]);
    assert.equal(second.filed.length, 1);
    const [t] = w.ciTickets();
    assert.equal(t?.title, '[ci] Failing: Pet#notFound');
    assert.equal(t?.priority, 'p1');
    assert.equal(t?.needs_triage, 1);
    assert.match(t?.body ?? '', /c2/);
    assert.match(t?.body ?? '', /Status expected:<404> but was:<500>/);
    assert.deepEqual(w.run('c2', [w.res('Pet#notFound', 'fail')]).filed, []);
    assert.equal(w.ciTickets().length, 1);
  } finally {
    w.cleanup();
  }
});

test('pass and fail on the same commit is flaky (p2); a Surefire rerun flake is flaky at once', () => {
  const w = world();
  try {
    w.run('c1', [w.res('Owner#find', 'pass'), w.res('Vet#list', 'pass')]);
    const flip = w.run('c1', [w.res('Owner#find', 'fail'), w.res('Vet#list', 'pass', true)]);
    assert.deepEqual(flip.filed.map((f) => f.kind).sort(), ['flaky', 'flaky']);
    const titles = w
      .ciTickets()
      .map((t) => [t.title, t.priority])
      .sort();
    assert.deepEqual(titles, [
      ['[ci] Flaky: Owner#find', 'p2'],
      ['[ci] Flaky: Vet#list', 'p2'],
    ]);
    assert.deepEqual(
      w.run('c1', [w.res('Owner#find', 'fail'), w.res('Vet#list', 'pass', true)]).filed,
      [],
    );
  } finally {
    w.cleanup();
  }
});

test('two broken runs in a row file one broken-build ticket; a later run that reports tests recovers it', () => {
  const w = world();
  try {
    assert.deepEqual(w.run('c1', [], 1).filed, []);
    const second = w.run('c2', [], 1);
    assert.equal(second.filed[0]?.kind, 'broken');
    const [t] = w.ciTickets();
    assert.equal(t?.title, '[ci] Build broken on the default branch');
    assert.match(t?.body ?? '', /cannot find symbol/);
    const after = w.run('c3', [w.res('A#ok', 'pass')]);
    assert.deepEqual(after.recovered, [t?.id]);
    assert.equal(getTicketEvents(w.db, t?.id as number).at(-1)?.event, 'recovered');
    assert.deepEqual(w.run('c4', [w.res('A#ok', 'pass')]).recovered, [], 'recovered once');
  } finally {
    w.cleanup();
  }
});

test('a failing test that passes again gets one recovered event on its open ticket', () => {
  const w = world();
  try {
    w.run('c1', [w.res('Pet#notFound', 'fail')]);
    w.run('c2', [w.res('Pet#notFound', 'fail')]);
    const [t] = w.ciTickets();
    const r = w.run('c3', [w.res('Pet#notFound', 'pass')]);
    assert.deepEqual(r.recovered, [t?.id]);
    const ev = getTicketEvents(w.db, t?.id as number).at(-1);
    assert.equal(ev?.event, 'recovered');
    assert.match(ev?.payload ?? '', /c3/);
  } finally {
    w.cleanup();
  }
});

test('dismissed (suppressed) or closed as a duplicate of an open ticket: never re-filed', () => {
  const w = world();
  try {
    w.run('c1', [w.res('Pet#notFound', 'fail')]);
    w.run('c2', [w.res('Pet#notFound', 'fail')]);
    const [t] = w.ciTickets();
    // Closed as a duplicate of an open human report: stays tracked there.
    const human = createTicket(
      w.db,
      { kind: 'bug', title: 'Stale link 500', body: 'b', origin: 'human' },
      { actor: 'human' },
    );
    createLink(w.db, {
      from_ticket: t?.id as number,
      to_ticket: human,
      rel: 'duplicates',
      note: null,
    });
    closeTicket(
      w.db,
      t?.id as number,
      { status: 'duplicate', resolution: 'same as the report' },
      { actor: 'human' },
    );
    assert.deepEqual(w.run('c3', [w.res('Pet#notFound', 'fail')]).filed, []);
    // Dismissed as wontfix and suppressed: stays quiet.
    w.run('c1', [w.res('Legacy#slow', 'fail')]);
    w.run('c2', [w.res('Legacy#slow', 'fail')]);
    const legacy = w.ciTickets().find((x) => x.title.includes('Legacy#slow'));
    closeTicket(
      w.db,
      legacy?.id as number,
      { status: 'wontfix', resolution: 'known slow' },
      { actor: 'human' },
    );
    suppressFingerprint(w.db, legacy?.fingerprint as string, 'dismissed');
    assert.deepEqual(w.run('c3', [w.res('Legacy#slow', 'fail')]).filed, []);
  } finally {
    w.cleanup();
  }
});

test('fail then pass on the same commit is flaky too — found on the PetClinic trial', () => {
  const w = world();
  try {
    assert.deepEqual(w.run('c1', [w.res('Demo#halfTheTime', 'fail')]).filed, []);
    const second = w.run('c1', [w.res('Demo#halfTheTime', 'pass')]);
    assert.deepEqual(
      second.filed.map((f) => [f.kind, f.testId]),
      [['flaky', 'Demo#halfTheTime']],
    );
    assert.deepEqual(w.run('c1', [w.res('Demo#halfTheTime', 'pass')]).filed, [], 'once');
  } finally {
    w.cleanup();
  }
});
