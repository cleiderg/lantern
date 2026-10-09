import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import type { EventContext } from '../types.ts';
import { createLink, getLinks } from './links.ts';
import {
  closeTicket,
  createTicket,
  getTicket,
  getTicketEvents,
  listTickets,
  updateTicket,
} from './tickets.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-store-test-'));
  try {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      // Seed an agent row so FK is satisfied.
      db.prepare(`
        INSERT INTO agents (id, display_name, config_path, mission, workdir)
        VALUES ('test', 'Test', 'agents/test.agent.md', 'Testing', '/tmp')
      `).run();
      fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CTX: EventContext = { actor: 'human' };

// ─── createTicket ─────────────────────────────────────────────────────────────

test('createTicket returns a numeric id', () => {
  withDb((db) => {
    const id = createTicket(
      db,
      { kind: 'bug', title: 'crash', body: 'body', origin: 'human' },
      CTX,
    );
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });
});

test('createTicket writes a ticket_events row with event=created', () => {
  withDb((db) => {
    const id = createTicket(
      db,
      { kind: 'bug', title: 'crash', body: 'body', origin: 'human' },
      CTX,
    );
    const events = getTicketEvents(db, id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'created');
    assert.equal(events[0]?.actor, 'human');
    assert.equal(events[0]?.ticket_id, id);
  });
});

test('createTicket stores all supplied fields', () => {
  withDb((db) => {
    const id = createTicket(
      db,
      {
        agent_id: 'test',
        kind: 'enhancement',
        title: 'add dark mode',
        body: 'details',
        origin: 'human',
        fingerprint: 'fp-123',
        needs_triage: true,
        priority: 'p1',
        repo: 'myrepo',
      },
      CTX,
    );
    const t = getTicket(db, id);
    assert.ok(t !== undefined);
    assert.equal(t.kind, 'enhancement');
    assert.equal(t.priority, 'p1');
    assert.equal(t.fingerprint, 'fp-123');
    assert.equal(t.needs_triage, 1);
    assert.equal(t.status, 'open');
  });
});

// ─── updateTicket ─────────────────────────────────────────────────────────────

test('updateTicket writes a ticket_events row per mutation', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    updateTicket(db, id, { status: 'triage' }, CTX);

    const events = getTicketEvents(db, id);
    assert.equal(events.length, 2, 'create + update = 2 events');
    assert.equal(events[0]?.event, 'created');
    assert.equal(events[1]?.event, 'status_changed');
  });
});

test('multiple updates each write their own event', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    updateTicket(db, id, { status: 'triage' }, CTX);
    updateTicket(db, id, { priority: 'p1' }, CTX);
    updateTicket(db, id, { body: 'updated body' }, CTX);

    const events = getTicketEvents(db, id);
    assert.equal(events.length, 4, 'create + 3 updates = 4 events');
  });
});

test('updateTicket with no-op fields writes no event', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    updateTicket(db, id, {}, CTX); // nothing to update

    const events = getTicketEvents(db, id);
    assert.equal(events.length, 1, 'no-op update should not add an event');
  });
});

test('updateTicket reflects changed fields on the ticket row', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    updateTicket(db, id, { status: 'staffed', priority: 'p0' }, CTX);

    const t = getTicket(db, id);
    assert.equal(t?.status, 'staffed');
    assert.equal(t?.priority, 'p0');
  });
});

// ─── context propagation ──────────────────────────────────────────────────────

test('pulse_id and session_id propagate into ticket_events', () => {
  withDb((db) => {
    // Insert real pulse + session rows so FKs are satisfied.
    const pulseId = Number(
      db
        .prepare(
          `INSERT INTO pulses (agent_id, window_start, window_end)
           VALUES ('test', datetime('now','-1 hour'), datetime('now'))`,
        )
        .run().lastInsertRowid,
    );
    const sessId = 'sess-uuid-1234';
    db.prepare(`INSERT INTO sessions (id, tier) VALUES (?, 'read_only')`).run(sessId);
    const ctx: EventContext = { actor: 'lloyd', pulse_id: pulseId, session_id: sessId };
    const id = createTicket(
      db,
      { kind: 'chore', title: 'ct', body: 'b', origin: 'agent:self' },
      ctx,
    );
    const events = getTicketEvents(db, id);
    assert.equal(events[0]?.pulse_id, pulseId);
    assert.equal(events[0]?.session_id, sessId);
  });
});

// ─── listTickets ──────────────────────────────────────────────────────────────

test('listTickets returns all tickets when no filters', () => {
  withDb((db) => {
    createTicket(db, { kind: 'bug', title: 'a', body: 'b', origin: 'human' }, CTX);
    createTicket(db, { kind: 'chore', title: 'b', body: 'b', origin: 'human' }, CTX);
    assert.equal(listTickets(db).length, 2);
  });
});

test('listTickets filters by status', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 'a', body: 'b', origin: 'human' }, CTX);
    createTicket(db, { kind: 'bug', title: 'b', body: 'b', origin: 'human' }, CTX);
    updateTicket(db, id, { status: 'triage' }, CTX);

    const triaged = listTickets(db, { status: 'triage' });
    assert.equal(triaged.length, 1);
    assert.equal(triaged[0]?.id, id);
  });
});

test('listTickets filters by needs_triage', () => {
  withDb((db) => {
    createTicket(
      db,
      { kind: 'bug', title: 'a', body: 'b', origin: 'human', needs_triage: true },
      CTX,
    );
    createTicket(db, { kind: 'bug', title: 'b', body: 'b', origin: 'human' }, CTX);

    const needs = listTickets(db, { needs_triage: true });
    assert.equal(needs.length, 1);
    assert.equal(needs[0]?.needs_triage, 1);
  });
});

// ─── ticket_links ─────────────────────────────────────────────────────────────

test('createLink writes a ticket_links row', () => {
  withDb((db) => {
    const a = createTicket(db, { kind: 'bug', title: 'a', body: 'b', origin: 'human' }, CTX);
    const b = createTicket(db, { kind: 'bug', title: 'b', body: 'b', origin: 'human' }, CTX);
    createLink(db, { from_ticket: a, to_ticket: b, rel: 'relates_to' });

    const links = getLinks(db, a);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.rel, 'relates_to');
  });
});

test('createLink is idempotent (INSERT OR IGNORE)', () => {
  withDb((db) => {
    const a = createTicket(db, { kind: 'bug', title: 'a', body: 'b', origin: 'human' }, CTX);
    const b = createTicket(db, { kind: 'bug', title: 'b', body: 'b', origin: 'human' }, CTX);
    createLink(db, { from_ticket: a, to_ticket: b, rel: 'relates_to' });
    createLink(db, { from_ticket: a, to_ticket: b, rel: 'relates_to' }); // duplicate

    assert.equal(getLinks(db, a).length, 1);
  });
});

test('getLinks returns links in both directions', () => {
  withDb((db) => {
    const a = createTicket(db, { kind: 'bug', title: 'a', body: 'b', origin: 'human' }, CTX);
    const b = createTicket(db, { kind: 'bug', title: 'b', body: 'b', origin: 'human' }, CTX);
    createLink(db, { from_ticket: a, to_ticket: b, rel: 'blocks' });

    assert.equal(getLinks(db, b).length, 1, 'getLinks(b) should see the link from a→b');
  });
});

// ─── closeTicket ────────────────────────────────────────────────────────

test('closeTicket without resolution throws before changing any row', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    assert.throws(
      () => closeTicket(db, id, { status: 'closed', resolution: '' }, CTX),
      /non-empty resolution/,
    );
    // Row must be unchanged
    const t = getTicket(db, id);
    assert.equal(t?.status, 'open');
    assert.equal(t?.resolution, null);
    assert.equal(t?.closed_at, null);
    // No extra event written
    assert.equal(getTicketEvents(db, id).length, 1, 'only the created event');
  });
});

test('closeTicket with whitespace-only resolution throws', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    assert.throws(
      () => closeTicket(db, id, { status: 'closed', resolution: '   ' }, CTX),
      /non-empty resolution/,
    );
    assert.equal(getTicket(db, id)?.status, 'open');
  });
});

test('closeTicket with resolution sets status, closed_at, resolution and writes event', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    closeTicket(db, id, { status: 'closed', resolution: 'fixed in commit abc' }, CTX);

    const t = getTicket(db, id);
    assert.equal(t?.status, 'closed');
    assert.equal(t?.resolution, 'fixed in commit abc');
    assert.ok(t?.closed_at !== null, 'closed_at should be set');

    const events = getTicketEvents(db, id);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.event, 'closed');
  });
});

test('wontfix path: requires resolution, sets status=wontfix', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    closeTicket(db, id, { status: 'wontfix', resolution: 'out of scope for now' }, CTX);
    assert.equal(getTicket(db, id)?.status, 'wontfix');
    assert.equal(getTicketEvents(db, id).length, 2);
  });
});

test('duplicate path: requires resolution, sets status=duplicate', () => {
  withDb((db) => {
    const id = createTicket(db, { kind: 'bug', title: 't', body: 'b', origin: 'human' }, CTX);
    closeTicket(db, id, { status: 'duplicate', resolution: 'same as #1' }, CTX);
    assert.equal(getTicket(db, id)?.status, 'duplicate');
  });
});

// ── Every wontfix suppresses ─────────────────────────────────────────────────
// Only the agent's tickets_close tool suppressed the fingerprint; a human's
// dismissal (Triage, the page, the CLI) did not, so dismissed noise came back.

test('closeTicket: wontfix suppresses the ticket fingerprint, whoever closes it; closed/duplicate do not', () => {
  withDb((db) => {
    const obs = (fp: string) =>
      db
        .prepare('SELECT suppressed, suppress_reason FROM observations WHERE fingerprint = ?')
        .get(fp) as { suppressed: number; suppress_reason: string | null } | undefined;
    const ticketWith = (fp: string) => {
      db.prepare(
        `INSERT INTO observations (fingerprint, source, sample) VALUES (?, 'logs', 's')`,
      ).run(fp);
      return createTicket(
        db,
        {
          kind: 'bug',
          title: `t ${fp}`,
          body: 'b',
          origin: 'collector:logs',
          fingerprint: fp,
          needs_triage: true,
        },
        { actor: 'collector' },
      );
    };
    const human = ticketWith('fp-human');
    closeTicket(db, human, { status: 'wontfix', resolution: 'known noise' }, { actor: 'human' });
    assert.equal(obs('fp-human')?.suppressed, 1, 'a human dismissal suppresses');
    assert.match(obs('fp-human')?.suppress_reason ?? '', new RegExp(`#${human} closed as wontfix`));

    const agent = ticketWith('fp-agent');
    closeTicket(db, agent, { status: 'wontfix', resolution: 'demo error' }, { actor: 'petclinic' });
    assert.equal(obs('fp-agent')?.suppressed, 1, 'so does the agent');

    const fixed = ticketWith('fp-fixed');
    closeTicket(db, fixed, { status: 'closed', resolution: 'fixed' }, { actor: 'human' });
    assert.equal(obs('fp-fixed')?.suppressed, 0, 'fixed: it coming back is a regression');
    const dup = ticketWith('fp-dup');
    closeTicket(db, dup, { status: 'duplicate', resolution: 'same as #1' }, { actor: 'human' });
    assert.equal(obs('fp-dup')?.suppressed, 0, 'duplicate: tracked on its target');

    // A ticket with no fingerprint closes as before.
    const plain = createTicket(
      db,
      { kind: 'bug', title: 'plain', body: 'b', origin: 'human' },
      { actor: 'human' },
    );
    closeTicket(db, plain, { status: 'wontfix', resolution: 'no' }, { actor: 'human' });
  });
});
