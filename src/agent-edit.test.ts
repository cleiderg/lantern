import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getAgent, upsertAgentFromConfig } from './agent.ts';
import { loadAgentConfig } from './agent-config.ts';
import { configChanges, editAgentConfig, setFrontmatterValues } from './agent-edit.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';

const CONFIG = `---
id: pc
display_name: PetClinic
heartbeat: 15m      # every quarter hour
max_children: 1
workdir: /tmp/x
budget:
  per_pulse_usd: 1.00
  per_day_usd: 5.00
quiet_hours:
  - ["22:00", "07:00"]
test_commands:
  - sh /trial/test.sh
---

## Mission

Keep the clinic up.
`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-agent-edit-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const path = join(dir, 'pc.agent.md');
  writeFileSync(path, CONFIG);
  upsertAgentFromConfig(db, loadAgentConfig(path), path);
  return {
    dir,
    lanternDir,
    db,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('setFrontmatterValues: changes only the named values; comments, other keys and the body survive', () => {
  const out = setFrontmatterValues(CONFIG, {
    heartbeat: '30m',
    per_day_usd: 8,
    quiet_hours: [['23:00', '06:00']],
  });
  assert.match(out, /^heartbeat: 30m {6}# every quarter hour$/m, 'the comment is kept');
  assert.match(out, /^ {2}per_day_usd: 8\.00$/m);
  assert.match(out, /^ {2}per_pulse_usd: 1\.00$/m, 'the sibling is untouched');
  assert.match(out, /^quiet_hours: \[\["23:00", "06:00"\]\]$/m);
  assert.doesNotMatch(out, /"22:00"/, 'the old block list is gone');
  assert.match(out, /test_commands:\n {2}- sh \/trial\/test\.sh/);
  assert.ok(out.endsWith('## Mission\n\nKeep the clinic up.\n'));
  // A key that is not there yet is added inside the frontmatter.
  const bare = '---\nid: x\nworkdir: /tmp/x\n---\nbody\n';
  const added = setFrontmatterValues(bare, { max_children: 3, per_pulse_usd: 2 });
  assert.match(added, /^max_children: 3$/m);
  assert.match(added, /^budget:\n {2}per_pulse_usd: 2\.00$/m);
  assert.ok(added.endsWith('---\nbody\n'));
});

test('editAgentConfig: writes a validated file, backs up the old one, records the change, refreshes the agent', () => {
  const w = world();
  try {
    const r = editAgentConfig(
      w.db,
      w.lanternDir,
      'pc',
      { heartbeat: '30m', per_day_usd: 3 },
      { actor: 'human (ui)' },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    const cfg = loadAgentConfig(w.path);
    assert.equal(cfg.heartbeatSeconds, 1800);
    assert.equal(cfg.budget.perDayUsd, 3);
    assert.deepEqual(cfg.testCommands, ['sh /trial/test.sh'], 'file-only fields untouched');
    assert.equal(getAgent(w.db, 'pc')?.heartbeat_seconds, 1800, 'the agent row follows');
    const backups = readdirSync(join(w.lanternDir, 'config-backups'));
    assert.equal(backups.length, 1);
    assert.equal(
      readFileSync(join(w.lanternDir, 'config-backups', backups[0] as string), 'utf8'),
      CONFIG,
    );
    const log = configChanges(w.lanternDir, 'pc');
    assert.equal(log.length, 1);
    assert.equal(log[0]?.actor, 'human (ui)');
    assert.deepEqual(log[0]?.changes.per_day_usd, { from: 5, to: 3 });
    assert.deepEqual(log[0]?.changes.heartbeat, { from: '15m', to: '30m' });
  } finally {
    w.cleanup();
  }
});

test('editAgentConfig: increases need confirmation; caps, file-only fields and bad values are refused', () => {
  const w = world();
  try {
    const before = readFileSync(w.path, 'utf8');
    const up = editAgentConfig(
      w.db,
      w.lanternDir,
      'pc',
      { per_day_usd: 10 },
      { actor: 'human (ui)' },
    );
    assert.equal(up.ok, false);
    assert.equal(up.ok === false && up.needsConfirm, true);
    assert.match(up.ok === false ? up.error : '', /per_day_usd \$5\.00 → \$10\.00/);
    for (const [patch, why] of [
      [{ per_day_usd: 51 }, /at most \$50/],
      [{ per_pulse_usd: 6 }, /at most \$5/],
      [{ per_pulse_usd: 4, per_day_usd: 3 }, /per_pulse_usd .* per_day_usd/],
      [{ max_children: 11 }, /max_children/],
      [{ heartbeat: '10s' }, /heartbeat/],
      [{ heartbeat: 'soon' }, /heartbeat/],
      [{ quiet_hours: [['25:00', '07:00']] }, /quiet_hours/],
      [{ test_commands: ['sh evil.sh'] }, /test_commands is file-only/],
      [{ workdir: '/' }, /workdir is file-only/],
      [{ nonsense: 1 }, /unknown setting/],
      [{ per_day_usd: 5 }, /no change/],
    ] as const) {
      const r = editAgentConfig(w.db, w.lanternDir, 'pc', patch as Record<string, unknown>, {
        actor: 'human (ui)',
        confirm: true,
      });
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.match(r.ok === false ? r.error : '', why, JSON.stringify(patch));
    }
    assert.equal(readFileSync(w.path, 'utf8'), before, 'nothing was written');
    assert.ok(!existsSync(join(w.lanternDir, 'config-backups')));
    const confirmed = editAgentConfig(
      w.db,
      w.lanternDir,
      'pc',
      { per_day_usd: 10 },
      { actor: 'human (ui)', confirm: true },
    );
    assert.equal(confirmed.ok, true);
    assert.equal(
      editAgentConfig(w.db, w.lanternDir, 'nope', { per_day_usd: 1 }, { actor: 'x' }).ok,
      false,
    );
  } finally {
    w.cleanup();
  }
});
