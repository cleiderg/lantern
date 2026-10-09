import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tierFlags } from './tiers.ts';

// write tiers had `Bash(*)` and an empty disallow list, so Laws 1,
// 2 and 6 were prompt-only. The flags now allow only named commands; the git-layer
// push guard (worktree.test.ts) is the primary control, these are the backstop.

for (const tier of ['write_branch', 'release'] as const) {
  test(`tierFlags('${tier}'): no unrestricted shell`, () => {
    const { allowedTools } = tierFlags(tier);
    assert.ok(!allowedTools.includes('Bash(*)'), 'Bash(*) admits any command');
    assert.ok(!allowedTools.some((t) => t === 'Bash' || t.startsWith('Bash(sqlite3')));
  });

  test(`tierFlags('${tier}'): Appendix B disallow list`, () => {
    const { disallowedTools } = tierFlags(tier);
    for (const t of [
      'Bash(git push origin main*)',
      'Bash(git push --force*)',
      'Bash(git push -f*)',
      'Bash(git push --no-verify*)',
      'WebFetch',
    ]) {
      assert.ok(disallowedTools.includes(t), `missing ${t}`);
    }
  });

  test(`tierFlags('${tier}'): Appendix B allowlist for edit, test and commit`, () => {
    const { allowedTools } = tierFlags(tier);
    for (const t of [
      'Read',
      'Edit',
      'Write',
      'Bash(npm test *)',
      'Bash(npm run *)',
      'Bash(git add *)',
      'Bash(git commit *)',
      // not 'Bash(git push origin HEAD:*)': it never matched a real push;
      // the daemon pushes the branch instead — see "children do not push".
      'mcp__lantern__*',
    ]) {
      assert.ok(allowedTools.includes(t), `missing ${t}`);
    }
  });
}

test("tierFlags('release'): adds tagging on top of write_branch, and only that", () => {
  const write = new Set(tierFlags('write_branch').allowedTools);
  const extra = tierFlags('release').allowedTools.filter((t) => !write.has(t));
  assert.deepEqual(extra, ['Bash(git tag *)'], 'tagging only — the daemon pushes the tag');
});

test("tierFlags('write_branch'): cannot tag", () => {
  assert.ok(!tierFlags('write_branch').allowedTools.some((t) => t.includes('git tag')));
});

// ── sandbox flags ────────────────────────────────────────────────────────────

test('write tiers: children do not push — the daemon owns push', () => {
  for (const tier of ['write_branch', 'release'] as const) {
    const pushes = tierFlags(tier).allowedTools.filter(
      (t) => /git push/.test(t) && !/refs\/tags/.test(t),
    );
    assert.deepEqual(pushes, [], `${tier} may not push branches`);
  }
});

test('every tier names its built-in tools explicitly, and only those', () => {
  assert.deepEqual(tierFlags('read_only').tools, ['Bash', 'Read']);
  assert.deepEqual(tierFlags('write_branch').tools, [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'NotebookEdit',
  ]);
  assert.deepEqual(tierFlags('release').tools, tierFlags('write_branch').tools);
  for (const tier of ['read_only', 'write_branch', 'release'] as const) {
    for (const net of [
      'WebFetch',
      'WebSearch',
      'Agent',
      'RemoteTrigger',
      'SendMessage',
      'Artifact',
    ]) {
      assert.ok(!tierFlags(tier).tools.includes(net), `${tier} must not get ${net}`);
    }
  }
});

// ── per-agent test commands ────────────────────────────────────────────────────────────────

test("an agent's test commands reach the write tiers, and only them", () => {
  const extra = { testCommands: ['./mvnw -q test'] };
  for (const tier of ['write_branch', 'release'] as const) {
    const { allowedTools } = tierFlags(tier, extra);
    assert.ok(allowedTools.includes('Bash(./mvnw -q test)'), tier);
    assert.ok(allowedTools.includes('Bash(./mvnw -q test *)'), tier);
  }
  assert.deepEqual(tierFlags('read_only', extra), tierFlags('read_only'), 'read_only unchanged');
  assert.deepEqual(tierFlags('write_branch', { testCommands: [] }), tierFlags('write_branch'));
});
