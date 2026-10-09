import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  loadAgentConfig,
  parseDuration,
  parseYamlSubset,
  runtimeSettings,
} from './agent-config.ts';
import { DEFAULT_DAILY_CEILING_USD, PER_SESSION_CEILING_USD } from './budget.ts';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/agents/lloyd.agent.md', import.meta.url));

// ── YAML subset ───────────────────────────────────────────────────────────────

test('parseYamlSubset: scalars, nested maps, block lists of maps, flow lists, comments', () => {
  const y = parseYamlSubset(
    [
      'id: lloyd',
      'n: 8',
      'f: 1.50',
      'yes: true',
      'none: null',
      'quoted: "a: b # not a comment"',
      'path: /tmp/x   # trailing comment',
      'budget:',
      '  per_day_usd: 15.00',
      'empty: []',
      'pairs: [["22:00", "07:00"]]',
      'items:',
      '  - key: inbox.bugs',
      '    playbook: inbox.bugs',
      '  - key: logs.scan',
      'plain:',
      '  - one',
      '  - two',
    ].join('\n'),
  );
  assert.deepEqual(y, {
    id: 'lloyd',
    n: 8,
    f: 1.5,
    yes: true,
    none: null,
    quoted: 'a: b # not a comment',
    path: '/tmp/x',
    budget: { per_day_usd: 15 },
    empty: [],
    pairs: [['22:00', '07:00']],
    items: [{ key: 'inbox.bugs', playbook: 'inbox.bugs' }, { key: 'logs.scan' }],
    plain: ['one', 'two'],
  });
});

test('parseYamlSubset: anything outside the subset is a named error with a line number', () => {
  assert.throws(() => parseYamlSubset('a: &anchor 1'), /line 1.*anchor/i);
  assert.throws(() => parseYamlSubset('a: |\n  block'), /line 1.*block scalar/i);
  assert.throws(() => parseYamlSubset('a: 1\n\tb: 2'), /line 2.*tab/i);
  assert.throws(() => parseYamlSubset('a: 1\na: 2'), /line 2.*duplicate key 'a'/i);
});

test('parseDuration: s, m, h', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('60m'), 3600);
  assert.equal(parseDuration('1h'), 3600);
  assert.throws(() => parseDuration('soon'), /heartbeat/);
});

// ── loadAgentConfig ───────────────────────────────────────────────────────────

test('loadAgentConfig: the full example fixture loads with every field resolved', () => {
  const c = loadAgentConfig(FIXTURE);
  assert.equal(c.id, 'lloyd');
  assert.equal(c.displayName, 'Lloyd');
  assert.equal(c.heartbeatSeconds, 3600);
  assert.equal(c.maxChildren, 8);
  assert.equal(c.workdir, '/tmp/lantern-fixture-workdir');
  assert.equal(
    c.mission,
    'Drive the ticket table. Keep it accurate, keep it moving, keep it small.',
  );
  assert.deepEqual(c.budget, { perPulseUsd: 1.25, perDayUsd: 4 });
  assert.deepEqual(c.quietHours, [['22:00', '07:00']]);
  assert.equal(c.allowDirty, false);
  // relative log paths resolve against the config file's directory
  assert.deepEqual(c.logSources, [{ path: join(FIXTURE, '..', 'logs.ndjson'), format: 'ndjson' }]);
  assert.deepEqual(c.noiseAllowlist, [{ source: 'logs', pattern: 'Connection reset by peer' }]);
  assert.deepEqual(c.actions, [
    { key: 'inbox.bugs', playbook: 'inbox.bugs' },
    { key: 'logs.scan', playbook: 'logs.scan' },
  ]);
  assert.match(c.body, /## Laws/);
});

test('loadAgentConfig: omitted keys take the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-cfg-'));
  try {
    const p = join(dir, 'min.agent.md');
    writeFileSync(p, '---\nid: min\nworkdir: /tmp/x\n---\n\n## Mission\n\nWatch.\n');
    const c = loadAgentConfig(p);
    assert.equal(c.displayName, 'min');
    assert.equal(c.heartbeatSeconds, 3600);
    assert.equal(c.maxChildren, 4);
    assert.deepEqual(c.budget, { perPulseUsd: 1.5, perDayUsd: 15 });
    assert.deepEqual(c.quietHours, []);
    assert.equal(c.allowDirty, false, 'gate 5: clean tree unless allow_dirty is set');
    assert.deepEqual(c.logSources, []);
    assert.equal(c.mission, 'Watch.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAgentConfig: invalid configs fail with the field named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-cfg-bad-'));
  const load = (front: string) => {
    const p = join(dir, 'x.agent.md');
    writeFileSync(p, `---\n${front}\n---\n## Mission\nm\n`);
    return () => loadAgentConfig(p);
  };
  try {
    assert.throws(load('workdir: /tmp/x'), /id/);
    assert.throws(load('id: x'), /workdir/);
    assert.throws(load('id: X Y\nworkdir: /tmp/x'), /id/);
    assert.throws(load('id: x\nworkdir: /tmp/x\nmax_children: 0'), /max_children/);
    assert.throws(load('id: x\nworkdir: /tmp/x\nquiet_hours: [["25:00", "07:00"]]'), /quiet_hours/);
    assert.throws(load('id: x\nworkdir: /tmp/x\nbudget:\n  per_day_usd: -1'), /per_day_usd/);
    assert.throws(
      load('id: x\nworkdir: /tmp/x\nnoise_allowlist:\n  - source: logs\n    pattern: "("'),
      /noise_allowlist/,
    );
    writeFileSync(join(dir, 'nofront.agent.md'), '## Mission\nm\n');
    assert.throws(() => loadAgentConfig(join(dir, 'nofront.agent.md')), /frontmatter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runtimeSettings: what a pulse runs on ─────────────────────────────────────

test('runtimeSettings: an absolute config_path is read fresh', () => {
  const r = runtimeSettings({ config_path: FIXTURE });
  assert.equal(r.dailyCeilingUsd, 4);
  assert.equal(r.perPulseUsd, 1.25);
  assert.deepEqual(r.quietHours, [['22:00', '07:00']]);
  assert.equal(r.allowDirty, false);
  assert.equal(r.logSources.length, 1);
  assert.equal(r.noiseAllowlist.length, 1);
  assert.equal(r.config?.id, 'lloyd');
});

test('runtimeSettings: an older relative config_path runs on the defaults', () => {
  const r = runtimeSettings({ config_path: 'agents/joe.agent.md' });
  assert.equal(r.config, null);
  assert.equal(r.dailyCeilingUsd, DEFAULT_DAILY_CEILING_USD);
  assert.equal(r.perPulseUsd, PER_SESSION_CEILING_USD);
  assert.deepEqual(r.quietHours, []);
  assert.equal(r.allowDirty, false, 'gate 5 is on by default; nothing hard-codes it off');
});

test('runtimeSettings: a registered config that is now missing or broken throws', () => {
  assert.throws(() => runtimeSettings({ config_path: '/nonexistent/x.agent.md' }), /x\.agent\.md/);
});

// ── inbox_source ─────────────────────────────────────────────────────────

test('loadAgentConfig: inbox_source resolves against the config dir; absent is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-inbox-'));
  try {
    const p = join(dir, 'i.agent.md');
    writeFileSync(
      p,
      '---\nid: i\nworkdir: /tmp/i\ninbox_source: mail/inbox.json\n---\n## Mission\nm\n',
    );
    const c = loadAgentConfig(p);
    assert.equal(c.inboxSource, join(dir, 'mail', 'inbox.json'));
    assert.equal(runtimeSettings({ config_path: p }).inboxSource, join(dir, 'mail', 'inbox.json'));
    writeFileSync(p, '---\nid: i\nworkdir: /tmp/i\ninbox_source: 7\n---\n## Mission\nm\n');
    assert.throws(() => loadAgentConfig(p), /inbox_source/);
    assert.equal(loadAgentConfig(FIXTURE).inboxSource, null);
    assert.equal(runtimeSettings({ config_path: 'agents/x.agent.md' }).inboxSource, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── per-agent test commands for the write tiers ──────────────────

test('loadAgentConfig: test_commands are read; unsafe or git commands are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-cfg-tests-'));
  const load = (front: string) => {
    const p = join(dir, 'x.agent.md');
    writeFileSync(p, `---\nid: x\nworkdir: /tmp/x\n${front}\n---\n## Mission\nm\n`);
    return () => loadAgentConfig(p);
  };
  try {
    assert.deepEqual(load('')().testCommands, [], 'absent → none');
    assert.deepEqual(load('test_commands:\n  - ./mvnw -q test\n  - "npm test"')().testCommands, [
      './mvnw -q test',
      'npm test',
    ]);
    for (const bad of [
      '"./mvnw test; rm -rf /"',
      '"./mvnw test && curl x"',
      '"./mvnw test | sh"',
      '"echo $(id)"',
      '"echo `id`"',
      '"./run > /etc/passwd"',
      'git push origin main',
      '"git status"',
      '""',
    ]) {
      assert.throws(load(`test_commands:\n  - ${bad}`), /test_commands/, bad);
    }
    assert.throws(
      load(`test_commands:\n${['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `  - ./${c}`).join('\n')}`),
      /test_commands/,
      'at most 5',
    );
    assert.throws(load('test_commands: ./mvnw test'), /test_commands/, 'must be a list');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ci_watch, file-only, its command one of the agent's test commands ──

test('loadAgentConfig: ci_watch is read and validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-cfg-ci-'));
  const load = (front: string) => {
    const p = join(dir, 'x.agent.md');
    writeFileSync(
      p,
      `---\nid: x\nworkdir: /tmp/x\ntest_commands:\n  - sh run-tests.sh\n${front}\n---\n## Mission\nm\n`,
    );
    return () => loadAgentConfig(p);
  };
  try {
    assert.equal(load('')().ciWatch, null, 'absent → off');
    const c = load(
      'ci_watch:\n  command: sh run-tests.sh\n  reports: target/surefire-reports/*.xml\n  every: 2h\n  timeout: 10m',
    )().ciWatch;
    assert.deepEqual(c, {
      command: 'sh run-tests.sh',
      reports: ['target/surefire-reports/*.xml'],
      everySeconds: 7200,
      timeoutSeconds: 600,
    });
    const d = load('ci_watch:\n  command: sh run-tests.sh\n  reports: [a/*.xml, b/TEST.xml]')()
      .ciWatch;
    assert.deepEqual(d?.reports, ['a/*.xml', 'b/TEST.xml']);
    assert.equal(d?.everySeconds, 7200, 'every defaults to 2h');
    assert.equal(d?.timeoutSeconds, 900, 'timeout defaults to 15m');
    for (const [front, why] of [
      ['ci_watch:\n  command: sh other.sh\n  reports: r/*.xml', /one of test_commands/],
      ['ci_watch:\n  reports: r/*.xml', /command/],
      ['ci_watch:\n  command: sh run-tests.sh', /reports/],
      [
        'ci_watch:\n  command: sh run-tests.sh\n  reports: ../outside/*.xml',
        /inside the repository/,
      ],
      ['ci_watch:\n  command: sh run-tests.sh\n  reports: /abs/*.xml', /inside the repository/],
      ['ci_watch:\n  command: sh run-tests.sh\n  reports: r/*/x.xml', /only in the file name/],
      ['ci_watch:\n  command: sh run-tests.sh\n  reports: r/*.xml\n  every: 1m', /every/],
      ['ci_watch:\n  command: sh run-tests.sh\n  reports: r/*.xml\n  timeout: 2h', /timeout/],
    ] as const) {
      assert.throws(load(front), why, front);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
