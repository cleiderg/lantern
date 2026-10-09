import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readContext } from './context.ts';

/** Run fn with LANTERN_TIER set (or unset), restoring the original afterwards. */
function withTier<T>(tier: string | undefined, fn: () => T): T {
  const saved = process.env.LANTERN_TIER;
  if (tier === undefined) delete process.env.LANTERN_TIER;
  else process.env.LANTERN_TIER = tier;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.LANTERN_TIER;
    else process.env.LANTERN_TIER = saved;
  }
}

// the tier used to default to 'orchestrator' — the most privileged
// one — whenever nothing said otherwise.
test('readContext: an unset LANTERN_TIER fails closed to read_only', () => {
  assert.equal(withTier(undefined, readContext).tier, 'read_only');
});

test('readContext: an unknown LANTERN_TIER fails closed to read_only', () => {
  assert.equal(withTier('superuser', readContext).tier, 'read_only');
});

test('readContext: every real tier passes through', () => {
  for (const tier of ['orchestrator', 'read_only', 'write_branch', 'release']) {
    assert.equal(withTier(tier, readContext).tier, tier);
  }
});
