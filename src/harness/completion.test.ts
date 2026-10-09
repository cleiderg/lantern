import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CompletionInput, decideCompletion } from './completion.ts';

const base: CompletionInput = {
  finalStatus: 'done',
  outcome: 'fixed',
  branch: null,
  pr: null,
  tag: null,
  reviewBase: 'main',
};
const PR = { ok: true as const, kind: 'pr' as const, url: 'https://github.com/o/r/pull/7' };
const BRANCH = { ok: true as const, kind: 'branch' as const, remote: 'origin', why: 'not GitHub' };

// [name, input overrides, session event, status, events, other patch fields]
const cases: Array<[string, Partial<CompletionInput>, string, string, string[], object]> = [
  ['read_only done', {}, 'completed', 'in_review', [], {}],
  ['timed out', { finalStatus: 'timeout' }, 'timeout', 'open', [], {}],
  ['failed', { finalStatus: 'failed', outcome: null }, 'error', 'open', [], {}],
  ['done but blocked', { outcome: 'blocked' }, 'completed', 'blocked', [], {}],
  ['done but needs a human', { outcome: 'needs_human' }, 'completed', 'blocked', [], {}],
  ['no structured result', { outcome: null }, 'completed', 'in_review', [], {}],
  [
    'draft PR opened',
    { branch: 'lantern/1', pr: PR },
    'completed',
    'in_review',
    [],
    { branch: 'lantern/1', pr_url: PR.url },
  ],
  [
    'branch pushed, no PR',
    { branch: 'lantern/1', pr: BRANCH, reviewBase: 'trunk' },
    'completed',
    'in_review',
    ['branch_pushed'],
    { branch: 'lantern/1' },
  ],
  [
    'PR opened, child blocked',
    { branch: 'lantern/1', pr: PR, outcome: 'blocked' },
    'completed',
    'blocked',
    [],
    { branch: 'lantern/1', pr_url: PR.url },
  ],
  [
    'push refused',
    { branch: 'lantern/1', pr: { ok: false, stage: 'push', error: 'hook' } },
    'completed',
    'blocked',
    ['error'],
    { branch: 'lantern/1' },
  ],
  [
    'PR not opened',
    { branch: 'lantern/1', pr: { ok: false, stage: 'pr', error: 'gh auth' } },
    'completed',
    'blocked',
    ['error'],
    { branch: 'lantern/1' },
  ],
  [
    'release tagged',
    { branch: 'lantern/1', pr: PR, tag: { ok: true, tag: 'v1.2.0' } },
    'completed',
    'in_review',
    ['tag_pushed'],
    { branch: 'lantern/1', pr_url: PR.url },
  ],
  [
    'tag refused wins over PR',
    { branch: 'lantern/1', pr: PR, tag: { ok: false, error: 'exists' } },
    'completed',
    'blocked',
    ['error'],
    { branch: 'lantern/1' },
  ],
];

test('decideCompletion: every outcome × publish × tag combination', () => {
  for (const [name, over, sessionEvent, status, events, patch] of cases) {
    const d = decideCompletion({ ...base, ...over });
    assert.equal(d.sessionEvent, sessionEvent, name);
    assert.deepEqual(d.patch, { status, ...patch }, name);
    assert.deepEqual(
      d.events.map((e) => e.event),
      events,
      name,
    );
  }
});

test('decideCompletion: the evidence each event carries', () => {
  const pushed = decideCompletion({
    ...base,
    branch: 'lantern/1',
    pr: BRANCH,
    reviewBase: 'trunk',
  });
  assert.deepEqual(pushed.events[0]?.payload, {
    branch: 'lantern/1',
    remote: 'origin',
    review: 'git diff trunk...lantern/1',
    why_no_pr: 'not GitHub',
  });
  const refused = decideCompletion({
    ...base,
    branch: 'lantern/1',
    pr: { ok: false, stage: 'push', error: 'hook' },
  });
  assert.deepEqual(refused.events[0]?.payload, {
    reason: 'branch not pushed: hook',
    branch: 'lantern/1',
  });
  const tag = decideCompletion({
    ...base,
    branch: 'lantern/1',
    pr: PR,
    tag: { ok: false, error: 'exists' },
  });
  assert.deepEqual(tag.events[0]?.payload, {
    reason: 'tag not pushed: exists',
    branch: 'lantern/1',
  });
});
