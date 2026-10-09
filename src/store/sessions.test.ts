import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import {
  createSession,
  getLiveSessions,
  getSession,
  listSessions,
  updateSession,
} from './sessions.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-ses-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('createSession: inserts a row with status=starting', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    createSession(db, { id, agentId: agent.id, tier: 'read_only' });
    const row = getSession(db, id);
    assert.ok(row !== undefined);
    assert.equal(row.id, id);
    assert.equal(row.status, 'starting');
    assert.equal(row.tier, 'read_only');
  } finally {
    cleanup();
  }
});

test('updateSession: changes status and records cost', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = 'aaaaaaaa-0000-0000-0000-000000000002';
    createSession(db, { id, agentId: agent.id, tier: 'read_only' });
    updateSession(db, id, { status: 'done', costUsd: 0.05, numTurns: 5 });
    const row = getSession(db, id);
    assert.ok(row !== undefined);
    assert.equal(row.status, 'done');
    assert.equal(row.cost_usd, 0.05);
    assert.equal(row.num_turns, 5);
  } finally {
    cleanup();
  }
});

test('listSessions --live: returns only starting/running/waiting sessions', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id1 = 'aaaaaaaa-0000-0000-0000-000000000003';
    const id2 = 'aaaaaaaa-0000-0000-0000-000000000004';
    createSession(db, { id: id1, agentId: agent.id, tier: 'read_only' }); // starting
    createSession(db, { id: id2, agentId: agent.id, tier: 'write_branch' });
    updateSession(db, id2, { status: 'done' });

    const live = listSessions(db, { live: true });
    assert.equal(live.length, 1);
    assert.equal(live[0]?.id, id1);
  } finally {
    cleanup();
  }
});

test('getLiveSessions: returns sessions for a specific agent', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = 'aaaaaaaa-0000-0000-0000-000000000005';
    createSession(db, { id, agentId: agent.id, tier: 'read_only' });
    const sessions = getLiveSessions(db, agent.id);
    assert.ok(sessions.some((s) => s.id === id));
  } finally {
    cleanup();
  }
});

test('getSession: returns undefined for unknown id', () => {
  const { db, cleanup } = setup();
  try {
    assert.equal(getSession(db, 'not-a-real-id'), undefined);
  } finally {
    cleanup();
  }
});
