import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from '../agent.ts';
import { openDb } from '../db.ts';
import { runMigrations } from '../migrate.ts';
import { createTicket } from '../store/tickets.ts';
import {
  answerEscalation,
  createEscalation,
  getEscalation,
  getOpenBlockingEscalation,
  hasApproval,
  listUnanswered,
} from './escalations.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-escalations-'));
  const db = openDb(join(dir, 'lantern.db'));
  runMigrations(db);
  const agent = ensureDefaultAgent(db, dir);
  return { dir, db, agent, cleanup: () => rmSync(dir, { recursive: true }) };
}

function seedTicket(db: ReturnType<typeof openDb>): number {
  return createTicket(
    db,
    { kind: 'release', title: 'Ship v2', body: 'cut the release', origin: 'human' },
    { actor: 'test' },
  );
}

test('createEscalation + getEscalation: round-trips a row', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = createEscalation(db, {
      agentId: agent.id,
      severity: 'decide',
      question: 'Which branch?',
      options: ['main', 'release/v2'],
    });
    const row = getEscalation(db, id);
    assert.ok(row !== undefined);
    assert.equal(row.severity, 'decide');
    assert.equal(row.question, 'Which branch?');
    assert.equal(row.answered_at, null);
    assert.deepEqual(JSON.parse(row.options ?? '[]'), ['main', 'release/v2']);
  } finally {
    cleanup();
  }
});

test('listUnanswered: returns only unanswered rows, oldest first', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id1 = createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'first' });
    const id2 = createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'second' });
    answerEscalation(db, id1, 'noted', 'human');

    const open = listUnanswered(db);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, id2);
  } finally {
    cleanup();
  }
});

test('listUnanswered: scopes to one agent when given', () => {
  const { db, agent, cleanup } = setup();
  try {
    db.prepare(
      `INSERT INTO agents (id, display_name, config_path, mission, workdir)
       VALUES ('other-agent', 'Other', '/tmp/other.md', 'other mission', '/tmp')`,
    ).run();
    createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'mine' });
    createEscalation(db, { agentId: 'other-agent', severity: 'fyi', question: 'not mine' });

    const mine = listUnanswered(db, { agentId: agent.id });
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.question, 'mine');
  } finally {
    cleanup();
  }
});

test('answerEscalation: sets answer/answered_by/answered_at', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'q' });
    answerEscalation(db, id, 'go with main', 'human');

    const row = getEscalation(db, id);
    assert.equal(row?.answer, 'go with main');
    assert.equal(row?.answered_by, 'human');
    assert.ok(row?.answered_at);
  } finally {
    cleanup();
  }
});

test('answerEscalation: throws on unknown id', () => {
  const { db, cleanup } = setup();
  try {
    assert.throws(() => answerEscalation(db, 999, 'x', 'human'), /not found/);
  } finally {
    cleanup();
  }
});

test('answerEscalation: throws if already answered', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = createEscalation(db, { agentId: agent.id, severity: 'fyi', question: 'q' });
    answerEscalation(db, id, 'first answer', 'human');
    assert.throws(() => answerEscalation(db, id, 'second answer', 'human'), /already answered/);
  } finally {
    cleanup();
  }
});

test('getOpenBlockingEscalation: finds an unanswered blocking escalation for a ticket', () => {
  const { db, agent, cleanup } = setup();
  try {
    const ticketId = seedTicket(db);
    createEscalation(db, {
      agentId: agent.id,
      severity: 'fyi',
      question: 'not blocking',
      ticketId,
    });
    const blockingId = createEscalation(db, {
      agentId: agent.id,
      severity: 'blocking',
      question: 'blocking one',
      ticketId,
    });

    const found = getOpenBlockingEscalation(db, ticketId);
    assert.equal(found?.id, blockingId);
  } finally {
    cleanup();
  }
});

test('getOpenBlockingEscalation: returns undefined once the blocking escalation is answered', () => {
  const { db, agent, cleanup } = setup();
  try {
    const ticketId = seedTicket(db);
    const blockingId = createEscalation(db, {
      agentId: agent.id,
      severity: 'blocking',
      question: 'blocking one',
      ticketId,
    });
    answerEscalation(db, blockingId, 'ok proceed', 'human');

    assert.equal(getOpenBlockingEscalation(db, ticketId), undefined);
  } finally {
    cleanup();
  }
});

test('getOpenBlockingEscalation: undefined when the ticket has no escalations', () => {
  const { db, cleanup } = setup();
  try {
    const ticketId = seedTicket(db);
    assert.equal(getOpenBlockingEscalation(db, ticketId), undefined);
  } finally {
    cleanup();
  }
});

// approval is an explicit verdict. It used to be "any answered
// escalation on the ticket" — so an fyi answered "no" released the ticket.

test('hasApproval: only an approve verdict approves; a plain answer does not', () => {
  const { db, agent, cleanup } = setup();
  try {
    const ticketId = seedTicket(db);
    assert.equal(hasApproval(db, ticketId), false, 'no escalation at all → not approved');

    const ask = () =>
      createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'ok?', ticketId });
    const plain = ask();
    assert.equal(hasApproval(db, ticketId), false, 'unanswered → not approved');
    answerEscalation(db, plain, 'no, not yet', 'human');
    assert.equal(hasApproval(db, ticketId), false, 'an answer without a verdict is not approval');

    answerEscalation(db, ask(), 'ship it', 'human', 'approve');
    assert.equal(hasApproval(db, ticketId), true, 'approve → approved');
  } finally {
    cleanup();
  }
});

test('hasApproval: the latest verdict wins — a later reject revokes, a later approve restores', () => {
  const { db, agent, cleanup } = setup();
  try {
    const ticketId = seedTicket(db);
    const ask = () =>
      createEscalation(db, { agentId: agent.id, severity: 'decide', question: 'ok?', ticketId });
    answerEscalation(db, ask(), 'yes', 'human', 'approve');
    answerEscalation(db, ask(), 'hold on, found a bug', 'human', 'reject');
    assert.equal(hasApproval(db, ticketId), false);
    answerEscalation(db, ask(), 'fixed, go', 'human', 'approve');
    assert.equal(hasApproval(db, ticketId), true);
    // A later verdict-less answer doesn't change it either way.
    answerEscalation(db, ask(), 'fyi noted', 'human');
    assert.equal(hasApproval(db, ticketId), true);
  } finally {
    cleanup();
  }
});

test('answerEscalation: stores the verdict; a rejected escalation is still answered', () => {
  const { db, agent, cleanup } = setup();
  try {
    const id = createEscalation(db, { agentId: agent.id, severity: 'blocking', question: 'go?' });
    answerEscalation(db, id, 'no', 'human', 'reject');
    const row = getEscalation(db, id);
    assert.equal(row?.verdict, 'reject');
    assert.ok(row?.answered_at, 'a reject unblocks the queue; it just does not approve');
  } finally {
    cleanup();
  }
});
