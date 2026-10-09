import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { lastRun, recordRun, runResults, testHistory } from './ci.ts';

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-ci-store-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, dir);
  return { db, agent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const r = (testId: string, outcome: 'pass' | 'fail' | 'error' | 'skip', message = '') => ({
  testId,
  classname: testId.split('#')[0] as string,
  name: testId.split('#')[1] as string,
  outcome,
  ms: 5,
  message,
  flaky: false,
});

test('recordRun: one run + its results in one transaction; status from the results', () => {
  const w = world();
  try {
    const id = recordRun(w.db, {
      agentId: w.agent.id,
      pulseId: null,
      sha: 'abc123',
      exitCode: 1,
      results: [r('A#ok', 'pass'), r('A#bad', 'fail', 'expected 404')],
    });
    const run = lastRun(w.db, w.agent.id);
    assert.equal(run?.id, id);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.tests, 2);
    assert.deepEqual(
      runResults(w.db, id).map((x) => [x.test_id, x.outcome]),
      [
        ['A#bad', 'fail'],
        ['A#ok', 'pass'],
      ],
    );
    const ok = recordRun(w.db, {
      agentId: w.agent.id,
      pulseId: null,
      sha: 'abc123',
      exitCode: 0,
      results: [r('A#ok', 'pass')],
    });
    assert.equal(lastRun(w.db, w.agent.id)?.id, ok);
    assert.equal(lastRun(w.db, w.agent.id)?.status, 'passed');
    // No report at all: broken (or timeout), with the reason.
    recordRun(w.db, {
      agentId: w.agent.id,
      pulseId: null,
      sha: 'abc123',
      exitCode: 2,
      results: [],
      detail: 'compile error',
    });
    assert.equal(lastRun(w.db, w.agent.id)?.status, 'broken');
    recordRun(w.db, {
      agentId: w.agent.id,
      pulseId: null,
      sha: 'abc123',
      exitCode: null,
      results: [],
      timedOut: true,
    });
    assert.equal(lastRun(w.db, w.agent.id)?.status, 'timeout');
  } finally {
    w.cleanup();
  }
});

test('testHistory: passes and failures per test on one commit', () => {
  const w = world();
  try {
    const run = (sha: string, outcome: 'pass' | 'fail') =>
      recordRun(w.db, {
        agentId: w.agent.id,
        pulseId: null,
        sha,
        exitCode: outcome === 'pass' ? 0 : 1,
        results: [r('A#flip', outcome), r('A#steady', 'pass')],
      });
    run('c1', 'pass');
    run('c1', 'fail');
    run('c1', 'pass');
    run('c2', 'fail');
    assert.deepEqual(testHistory(w.db, w.agent.id, 'A#flip', 'c1'), {
      runs: 3,
      pass: 2,
      fail: 1,
      error: 0,
      skip: 0,
    });
    assert.deepEqual(testHistory(w.db, w.agent.id, 'A#flip', 'c2'), {
      runs: 1,
      pass: 0,
      fail: 1,
      error: 0,
      skip: 0,
    });
  } finally {
    w.cleanup();
  }
});
