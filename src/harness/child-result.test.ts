import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHILD_RESULT_SCHEMA, parseChildResult } from './child-result.ts';

test('CHILD_RESULT_SCHEMA: outcome + summary required, the outcome enum', () => {
  assert.deepEqual(CHILD_RESULT_SCHEMA.required, ['outcome', 'summary']);
  assert.deepEqual(CHILD_RESULT_SCHEMA.properties.outcome.enum, [
    'fixed',
    'partial',
    'blocked',
    'no_action',
    'needs_human',
  ]);
});

test('parseChildResult: keeps what conforms, drops what does not, null without outcome/summary', () => {
  assert.deepEqual(
    parseChildResult({
      outcome: 'fixed',
      summary: 'Added a timeout.',
      root_cause: 'axios without timeout',
      files_touched: ['server/a.js', 7],
      tests_added: 'yes',
      confidence: 'high',
      follow_up_tickets: [
        { kind: 'bug', title: 'Also in b.js', body: 'same pattern' },
        { kind: 'wish', title: 'x', body: 'y' },
        { kind: 'docs', title: 'no body' },
      ],
      extra: 'ignored',
    }),
    {
      outcome: 'fixed',
      summary: 'Added a timeout.',
      root_cause: 'axios without timeout',
      files_touched: ['server/a.js'],
      confidence: 'high',
      follow_up_tickets: [{ kind: 'bug', title: 'Also in b.js', body: 'same pattern' }],
    },
  );
  assert.equal(parseChildResult({ outcome: 'yolo', summary: 's' }), null);
  assert.equal(parseChildResult({ outcome: 'fixed' }), null);
  assert.equal(parseChildResult('fixed'), null);
  assert.equal(parseChildResult(undefined), null);
});
