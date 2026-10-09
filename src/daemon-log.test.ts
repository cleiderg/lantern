import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemonLogger, daemonLogPath, readDaemonLog } from './daemon-log.ts';

test('daemon log: JSON lines under logs/, one object per line', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-dlog-'));
  try {
    const log = createDaemonLogger(lanternDir, 'pc', () => new Date('2026-10-03T10:00:00Z'));
    log('lantern daemon started — agent="PetClinic"');
    log('pulse 3 error — harness exited 1');
    assert.equal(daemonLogPath(lanternDir), join(lanternDir, 'logs', 'lanternd.log'));
    const lines = readFileSync(daemonLogPath(lanternDir), 'utf8').trim().split('\n');
    const [a, b] = lines.map((l) => JSON.parse(l));
    assert.deepEqual(a, {
      ts: '2026-10-03T10:00:00.000Z',
      level: 'info',
      agent: 'pc',
      msg: 'lantern daemon started — agent="PetClinic"',
    });
    assert.equal(b.level, 'error', 'an error line says so');
    assert.match(readDaemonLog(lanternDir), /agent="PetClinic"/, 'readable as plain text');
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('daemon log: a write after UTC midnight rotates the previous day out', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-dlog-'));
  try {
    let now = new Date('2026-10-03T23:59:59Z');
    const log = createDaemonLogger(lanternDir, 'pc', () => now);
    log('before midnight');
    now = new Date('2026-10-04T00:00:01Z');
    log('after midnight');
    const dir = join(lanternDir, 'logs');
    assert.deepEqual(readdirSync(dir).sort(), ['lanternd-2026-10-03.log', 'lanternd.log']);
    assert.match(readFileSync(join(dir, 'lanternd-2026-10-03.log'), 'utf8'), /before midnight/);
    assert.doesNotMatch(readFileSync(join(dir, 'lanternd.log'), 'utf8'), /before midnight/);
    assert.match(readFileSync(join(dir, 'lanternd.log'), 'utf8'), /after midnight/);

    // A second process (another agent's daemon) on the new day finds the file
    // already rotated and just appends.
    const other = createDaemonLogger(lanternDir, 'reviewer', () => now);
    other('second daemon');
    assert.equal(readdirSync(dir).length, 2);
    assert.match(
      readDaemonLog(lanternDir),
      /before midnight[\s\S]*after midnight[\s\S]*second daemon/,
    );
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});

test('daemon log: a file left from an earlier day is rotated on the first write', () => {
  const lanternDir = mkdtempSync(join(tmpdir(), 'lantern-dlog-'));
  try {
    createDaemonLogger(lanternDir, 'pc', () => new Date('2026-10-01T12:00:00Z'))('old day');
    createDaemonLogger(lanternDir, 'pc', () => new Date('2026-10-03T08:00:00Z'))('restart');
    assert.ok(existsSync(join(lanternDir, 'logs', 'lanternd-2026-10-01.log')));
  } finally {
    rmSync(lanternDir, { recursive: true, force: true });
  }
});
