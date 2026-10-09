/**
 * The rules for changing a ticket live in one module,
 * for the agent's MCP tools and the human's actions alike. A human's
 * wontfix not suppressing its fingerprint was the bug their split produced.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureDefaultAgent } from './agent.ts';
import { openDb } from './db.ts';
import { initLantern } from './init.ts';
import { createSession } from './store/sessions.ts';
import { createTicket, getTicket } from './store/tickets.ts';
import { acceptTicket, checkUpdate, closeAs, staffRefusal } from './ticket-policy.ts';

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-policy-'));
  const lanternDir = join(dir, 'lantern');
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, dir);
  const t = (needs_triage = false, origin = 'collector:logs') =>
    createTicket(
      db,
      {
        kind: 'bug',
        title: 't',
        body: 'b',
        origin: origin as 'human',
        needs_triage,
        agent_id: agent.id,
      },
      { actor: 'x' },
    );
  return { db, agent, t, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('checkUpdate: nobody sets a terminal status by update; only a human clears needs_triage', () => {
  const w = world();
  try {
    const id = w.t(true);
    const ticket = getTicket(w.db, id);
    assert.match(
      checkUpdate('agent', ticket, { status: 'closed' }) ?? '',
      /use tickets_close|resolution/,
    );
    assert.match(checkUpdate('human', ticket, { status: 'wontfix' }) ?? '', /resolution/);
    assert.match(
      checkUpdate('agent', ticket, { needs_triage: false }) ?? '',
      /only a human accepts/,
    );
    assert.equal(checkUpdate('agent', ticket, { needs_triage: true, priority: 'p1' }), null);
    assert.equal(checkUpdate('human', ticket, { needs_triage: false }), null);
    assert.match(checkUpdate('agent', undefined, {}) ?? '', /not found/);
  } finally {
    w.cleanup();
  }
});

test('closeAs: the same rules for the agent and a human — status, resolution, not already closed', () => {
  const w = world();
  try {
    const id = w.t();
    for (const actor of ['agent', 'human'] as const) {
      assert.match(closeAs(w.db, actor, 999, 'closed', 'x', { actor }) ?? '', /not found/);
      assert.match(
        closeAs(w.db, actor, id, 'open' as 'closed', 'x', { actor }) ?? '',
        /closed, wontfix or duplicate/,
      );
      assert.match(closeAs(w.db, actor, id, 'closed', '  ', { actor }) ?? '', /resolution/);
    }
    assert.equal(
      closeAs(w.db, 'agent', id, 'duplicate', 'same as #1', { actor: 'petclinic' }),
      null,
    );
    assert.equal(getTicket(w.db, id)?.status, 'duplicate');
    // Re-closing used to work for the agent (overwriting the resolution) and not for a human.
    for (const actor of ['agent', 'human'] as const) {
      assert.match(
        closeAs(w.db, actor, id, 'wontfix', 'changed my mind', { actor }) ?? '',
        /already duplicate — reopen it first/,
      );
    }
    assert.equal(getTicket(w.db, id)?.resolution, 'same as #1');
  } finally {
    w.cleanup();
  }
});

test('acceptTicket: a human clears needs_triage once', () => {
  const w = world();
  try {
    const id = w.t(true);
    assert.equal(acceptTicket(w.db, id), null);
    assert.equal(getTicket(w.db, id)?.needs_triage, 0);
    assert.match(acceptTicket(w.db, id) ?? '', /does not need triage/);
    assert.match(acceptTicket(w.db, 999) ?? '', /not found/);
  } finally {
    w.cleanup();
  }
});

test('staffRefusal: triage, terminal, ownership and live-session rules in one place', () => {
  const w = world();
  try {
    const untriaged = w.t(true);
    assert.match(
      staffRefusal(w.db, getTicket(w.db, untriaged), w.agent.id, 'read_only') ?? '',
      /awaiting triage/,
    );
    const ok = w.t(false);
    assert.equal(staffRefusal(w.db, getTicket(w.db, ok), w.agent.id, 'read_only'), null);
    assert.match(
      staffRefusal(w.db, getTicket(w.db, ok), 'someone-else', 'read_only') ?? '',
      /belongs to agent/,
    );
    createSession(w.db, { id: 's1', agentId: w.agent.id, tier: 'read_only', ticketId: ok });
    assert.match(
      staffRefusal(w.db, getTicket(w.db, ok), w.agent.id, 'read_only') ?? '',
      /already has a live session/,
    );
    assert.match(
      staffRefusal(w.db, getTicket(w.db, ok + 100), w.agent.id, 'read_only') ?? '',
      /not found/,
    );
    const rel = w.t(false, 'human');
    assert.match(
      staffRefusal(w.db, getTicket(w.db, rel), w.agent.id, 'release') ?? '',
      /release_requires_approval/,
    );
  } finally {
    w.cleanup();
  }
});
