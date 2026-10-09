/**
 * Fingerprinting and normalization, observation upserts and thresholds,
 * suppression, TTL and the rate-spike re-surface.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import {
  computeFingerprint,
  normalizeMessage,
  recordObservation,
  suppressFingerprint,
} from './observations.ts';
import { createRunningPulse } from './pulses.ts';
import { createTicket } from './tickets.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-obs-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

// ── Normalization ─────────────────────────────────────────────────────────────

test('normalizeMessage: strips ISO timestamps', () => {
  const a = normalizeMessage('Error at 2024-01-01T12:00:00Z in handler');
  const b = normalizeMessage('Error at 2024-06-15T23:59:59.999Z in handler');
  assert.equal(a, b);
});

test('normalizeMessage: strips UUIDs', () => {
  const a = normalizeMessage('Request id=abc12345-def4-4abc-8abc-123456789abc failed');
  const b = normalizeMessage('Request id=99999999-0000-4fff-bfff-000000000000 failed');
  assert.equal(a, b);
});

test('normalizeMessage: strips hex memory addresses', () => {
  const a = normalizeMessage('Crash at 0xdeadbeef in module');
  const b = normalizeMessage('Crash at 0x00001234 in module');
  assert.equal(a, b);
});

test('normalizeMessage: strips standalone integers', () => {
  const a = normalizeMessage('Connection refused on port 8080');
  const b = normalizeMessage('Connection refused on port 3000');
  assert.equal(a, b);
});

// ── Fingerprinting ───────────────────────────────────────────────────────────

test('computeFingerprint: same fingerprint for lines differing only in timestamp', () => {
  const fp1 = computeFingerprint(
    'logs',
    'Worker crash at 2026-01-01T10:00:00Z — exit code 1',
    'worker.ts:42',
  );
  const fp2 = computeFingerprint(
    'logs',
    'Worker crash at 2026-09-07T08:30:00Z — exit code 1',
    'worker.ts:42',
  );
  assert.equal(fp1, fp2, 'timestamps must not affect fingerprint');
});

test('computeFingerprint: same fingerprint for lines differing only in UUID', () => {
  const fp1 = computeFingerprint(
    'logs',
    'Request aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee timed out',
    'http.ts:88',
  );
  const fp2 = computeFingerprint(
    'logs',
    'Request 11111111-2222-4333-8444-555555555555 timed out',
    'http.ts:88',
  );
  assert.equal(fp1, fp2, 'UUIDs must not affect fingerprint');
});

test('computeFingerprint: different code_location → different fingerprint', () => {
  const fp1 = computeFingerprint('logs', 'Connection refused', 'db.ts:10');
  const fp2 = computeFingerprint('logs', 'Connection refused', 'db.ts:99');
  assert.notEqual(fp1, fp2, 'code_location must differentiate fingerprints');
});

test('computeFingerprint: different source → different fingerprint', () => {
  const fp1 = computeFingerprint('logs', 'timeout', 'server.ts:1');
  const fp2 = computeFingerprint('email', 'timeout', 'server.ts:1');
  assert.notEqual(fp1, fp2, 'source must differentiate fingerprints');
});

test('computeFingerprint: returns a 40-char sha1 hex string', () => {
  const fp = computeFingerprint('logs', 'any message', 'file.ts:1');
  assert.match(fp, /^[0-9a-f]{40}$/, 'fingerprint must be a 40-char hex string');
});

// ── Observation upsert + thresholds ──────────────────────────────────────────

test('recordObservation: 1 occurrence in 1 pulse is not ticketable', () => {
  const { db, cleanup } = setup();
  try {
    const r = recordObservation(db, {
      fingerprint: 'fp1',
      source: 'logs',
      sample: 'msg',
      pulseId: null,
    });
    assert.equal(r.ticketable, false);
    assert.equal(r.occurrences, 1);
    assert.equal(r.pulse_count, 1);
  } finally {
    cleanup();
  }
});

test('recordObservation: 3 occurrences in 1 pulse is NOT ticketable (pulse_count < 2)', () => {
  const { db, agent, cleanup } = setup();
  try {
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-01-01T01:00:00Z',
    });
    recordObservation(db, { fingerprint: 'fp2', source: 'logs', sample: 'msg', pulseId: p1 });
    recordObservation(db, { fingerprint: 'fp2', source: 'logs', sample: 'msg', pulseId: p1 });
    const r = recordObservation(db, {
      fingerprint: 'fp2',
      source: 'logs',
      sample: 'msg',
      pulseId: p1,
    });
    assert.equal(r.ticketable, false, '3 occurrences in 1 pulse must not be ticketable');
    assert.equal(r.occurrences, 3);
    assert.equal(r.pulse_count, 1);
  } finally {
    cleanup();
  }
});

test('recordObservation: 3 occurrences across 2 pulses IS ticketable', () => {
  const { db, agent, cleanup } = setup();
  try {
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-01-01T01:00:00Z',
    });
    const p2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T01:00:00Z',
      windowEnd: '2026-01-01T02:00:00Z',
    });

    recordObservation(db, { fingerprint: 'fp3', source: 'logs', sample: 'msg', pulseId: p1 });
    recordObservation(db, { fingerprint: 'fp3', source: 'logs', sample: 'msg', pulseId: p1 });
    const r = recordObservation(db, {
      fingerprint: 'fp3',
      source: 'logs',
      sample: 'msg',
      pulseId: p2,
    });
    assert.equal(r.ticketable, true, '3 occurrences across 2 pulses must be ticketable');
    assert.equal(r.occurrences, 3);
    assert.equal(r.pulse_count, 2);
  } finally {
    cleanup();
  }
});

test('recordObservation: severity=fault is ticketable immediately', () => {
  const { db, cleanup } = setup();
  try {
    const r = recordObservation(db, {
      fingerprint: 'fp-fault',
      source: 'logs',
      sample: 'crash log',
      severity: 'fault',
      pulseId: null,
    });
    assert.equal(r.ticketable, true, 'fault severity must be immediately ticketable');
    assert.equal(r.occurrences, 1);
  } finally {
    cleanup();
  }
});

test('recordObservation: severity=crash is ticketable immediately', () => {
  const { db, cleanup } = setup();
  try {
    const r = recordObservation(db, {
      fingerprint: 'fp-crash',
      source: 'logs',
      sample: 'crash log',
      severity: 'crash',
      pulseId: null,
    });
    assert.equal(r.ticketable, true, 'crash severity must be immediately ticketable');
  } finally {
    cleanup();
  }
});

test('recordObservation: prior human ticket makes fingerprint ticketable immediately', () => {
  const { db, agent, cleanup } = setup();
  try {
    const fp = 'fp-human';
    // File a human ticket with this fingerprint
    createTicket(
      db,
      {
        kind: 'bug',
        title: 'Human-reported bug',
        body: 'desc',
        origin: 'human',
        fingerprint: fp,
        agent_id: agent.id,
      },
      { actor: 'human' },
    );

    const r = recordObservation(db, {
      fingerprint: fp,
      source: 'logs',
      sample: 'msg',
      pulseId: null,
    });
    assert.equal(r.ticketable, true, 'prior human ticket must make fingerprint ticketable');
    assert.equal(r.occurrences, 1, 'should be first occurrence');
  } finally {
    cleanup();
  }
});

// ── Suppression + TTL ─────────────────────────────────────────────────────────

test('suppressFingerprint: suppressed fingerprint is not ticketable', () => {
  const { db, cleanup } = setup();
  try {
    // Make ticketable first (fault severity — immediate)
    recordObservation(db, {
      fingerprint: 'fp-s1',
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    suppressFingerprint(db, 'fp-s1', 'wontfix test');

    const r = recordObservation(db, {
      fingerprint: 'fp-s1',
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    assert.equal(r.suppressed, true);
    assert.equal(r.rate_spike, false);
    assert.equal(r.ticketable, false, 'suppressed fingerprint must not be ticketable');
  } finally {
    cleanup();
  }
});

test('suppressFingerprint: suppressed fingerprint still increments occurrences', () => {
  const { db, cleanup } = setup();
  try {
    recordObservation(db, {
      fingerprint: 'fp-s2',
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    suppressFingerprint(db, 'fp-s2', 'noise');

    const r1 = recordObservation(db, {
      fingerprint: 'fp-s2',
      source: 'logs',
      sample: 'msg',
      pulseId: null,
    });
    const r2 = recordObservation(db, {
      fingerprint: 'fp-s2',
      source: 'logs',
      sample: 'msg',
      pulseId: null,
    });
    assert.equal(r2.occurrences, 3, 'occurrences must increment even when suppressed');
    assert.equal(r2.suppressed, true);
    assert.equal(r1.ticketable, false);
  } finally {
    cleanup();
  }
});

test('suppressFingerprint: rate spike (10×) re-surfaces suppressed fingerprint', () => {
  const { db, agent, cleanup } = setup();
  try {
    const fp = 'fp-spike';
    const p1 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-01-01T01:00:00Z',
    });
    const p2 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T01:00:00Z',
      windowEnd: '2026-01-01T02:00:00Z',
    });
    const p3 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T02:00:00Z',
      windowEnd: '2026-01-01T03:00:00Z',
    });

    // Baseline: 1 occurrence per pulse × 3 pulses → rate = 1.0/pulse
    recordObservation(db, { fingerprint: fp, source: 'logs', sample: 'msg', pulseId: p1 });
    recordObservation(db, { fingerprint: fp, source: 'logs', sample: 'msg', pulseId: p2 });
    recordObservation(db, { fingerprint: fp, source: 'logs', sample: 'msg', pulseId: p3 });
    // At this point: occ=3, pulse_count=3, ticketable (3/2 threshold)

    suppressFingerprint(db, fp, 'noise test');
    // occurrences_at_suppress=3, pulse_count_at_suppress=3, baseline_rate=1.0

    const p4 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T03:00:00Z',
      windowEnd: '2026-01-01T04:00:00Z',
    });

    // Quiet: 2 occurrences in 1 new pulse → incremental rate = 2/1 = 2.0, well below 10×1.0
    recordObservation(db, { fingerprint: fp, source: 'logs', sample: 'msg', pulseId: p4 });
    const quiet = recordObservation(db, {
      fingerprint: fp,
      source: 'logs',
      sample: 'msg',
      pulseId: p4,
    });
    assert.equal(quiet.rate_spike, false, 'low-rate period must not trigger spike');
    assert.equal(quiet.ticketable, false);

    const p5 = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-01-01T04:00:00Z',
      windowEnd: '2026-01-01T05:00:00Z',
    });

    // Spike: 20 occurrences in p5 → total incremental occ=(2+20)=22, pulses=2
    // rate = 22/2 = 11.0 > 10 × 1.0 → spike
    for (let i = 0; i < 20; i++) {
      recordObservation(db, { fingerprint: fp, source: 'logs', sample: 'msg', pulseId: p5 });
    }
    const spike = recordObservation(db, {
      fingerprint: fp,
      source: 'logs',
      sample: 'msg',
      pulseId: p5,
    });
    assert.equal(spike.rate_spike, true, 'rate spike must be detected');
    assert.equal(spike.ticketable, true, 'rate spike must make fingerprint ticketable again');
    assert.equal(
      spike.suppressed,
      true,
      'fingerprint stays marked suppressed (caller decides to re-surface)',
    );
  } finally {
    cleanup();
  }
});

test('suppressFingerprint: suppression survives daemon restart (DB close + reopen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-obs-restart-'));
  const dbPath = join(dir, 'lantern.db');
  try {
    const db1 = openDb(dbPath);
    runMigrations(db1);
    ensureDefaultAgent(db1, dir);

    recordObservation(db1, {
      fingerprint: 'fp-restart',
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    suppressFingerprint(db1, 'fp-restart', 'wontfix');
    db1.close();

    // Reopen DB — simulates daemon restart
    const db2 = openDb(dbPath);
    runMigrations(db2);
    const r = recordObservation(db2, {
      fingerprint: 'fp-restart',
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    assert.equal(r.suppressed, true, 'suppression must survive DB close/reopen');
    assert.equal(
      r.ticketable,
      false,
      'suppressed fingerprint must not be ticketable after restart',
    );
    db2.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('suppressFingerprint: expired TTL clears suppression on next observation', () => {
  const { db, cleanup } = setup();
  try {
    const fp = 'fp-ttl';
    recordObservation(db, {
      fingerprint: fp,
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    suppressFingerprint(db, fp, 'ttl test');

    // Back-date suppress_until to simulate expiry
    db.prepare(
      "UPDATE observations SET suppress_until = '2020-01-01T00:00:00Z' WHERE fingerprint = ?",
    ).run(fp);

    // Next observation should clear suppression and see ticketable (fault severity)
    const r = recordObservation(db, {
      fingerprint: fp,
      source: 'logs',
      sample: 'msg',
      severity: 'fault',
      pulseId: null,
    });
    assert.equal(r.suppressed, false, 'expired suppression must be cleared');
    assert.equal(r.ticketable, true, 'fault severity after expired TTL must be ticketable');
  } finally {
    cleanup();
  }
});

// ── INFO lines are counted, never ticketed on repetition ────────────────
// Live trial: Kuma's routine INFO lines ("socket connected", "Adding route")
// recurred across pulses, crossed the occurrences>=3 / pulse_count>=2 bar, and
// became bug tickets the orchestrator then had to close as wontfix.

test('recordObservation: a recurring INFO line never crosses the bar; a warning does', () => {
  const { db, agent, cleanup } = setup();
  try {
    const pulses = [1, 2, 3].map(() =>
      createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' }),
    );
    const rec = (fingerprint: string, severity: string) =>
      pulses.map((pulseId) =>
        recordObservation(db, { fingerprint, source: 'logs', sample: 's', severity, pulseId }),
      );
    const info = rec('fp-info', 'info');
    assert.equal(info.at(-1)?.occurrences, 3, 'still counted, so it can be seen trending');
    assert.equal(info.at(-1)?.pulse_count, 3);
    assert.ok(
      info.every((o) => !o.ticketable),
      'INFO is never ticketable by repetition',
    );
    assert.equal(rec('fp-warn', 'warning').at(-1)?.ticketable, true, 'a warning still is');
  } finally {
    cleanup();
  }
});

test('recordObservation: an INFO fingerprint a human already ticketed is still ticketable', () => {
  const { db, agent, cleanup } = setup();
  try {
    createTicket(
      db,
      { kind: 'bug', title: 't', body: 'b', origin: 'human', fingerprint: 'fp-human-info' },
      { actor: 'human' },
    );
    const pulseId = createRunningPulse(db, { agentId: agent.id, windowStart: '', windowEnd: '' });
    const o = recordObservation(db, {
      fingerprint: 'fp-human-info',
      source: 'logs',
      sample: 's',
      severity: 'info',
      pulseId,
    });
    assert.equal(o.ticketable, true, 'explicit human intent outranks the severity rule');
  } finally {
    cleanup();
  }
});
