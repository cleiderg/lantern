import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { shouldFile } from './dedupe.ts';
import { createLink } from './links.ts';
import { closeTicket, createTicket } from './tickets.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-dedupe-'));
  try {
    const lanternDir = join(dir, 'lantern');
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const live = { suppressed: false, rate_spike: false };
const ticket = (db: ReturnType<typeof openDb>, fp: string | null, origin = 'collector:logs') =>
  createTicket(
    db,
    { kind: 'bug', title: 't', body: 'b', origin: origin as 'human', fingerprint: fp },
    { actor: 'x' },
  );

test('shouldFile: the noise rules in one place — open, suppressed, tracked elsewhere, or file', () => {
  withDb((db) => {
    assert.deepEqual(shouldFile(db, 'fp-new', live), { file: true }, 'never seen');

    const open = ticket(db, 'fp-open');
    assert.deepEqual(shouldFile(db, 'fp-open', live), {
      file: false,
      reason: 'open',
      ticketId: open,
    });

    assert.deepEqual(shouldFile(db, 'fp-x', { suppressed: true, rate_spike: false }), {
      file: false,
      reason: 'suppressed',
    });
    assert.deepEqual(
      shouldFile(db, 'fp-x', { suppressed: true, rate_spike: true }),
      { file: true },
      'a 10× spike wins',
    );

    // Closed as a duplicate of an open ticket: tracked there — through a chain, too.
    const canonical = ticket(db, null, 'human');
    const mid = ticket(db, 'fp-mid');
    createLink(db, { from_ticket: mid, to_ticket: canonical, rel: 'duplicates', note: null });
    closeTicket(db, mid, { status: 'duplicate', resolution: 'same' }, { actor: 'x' });
    const dup = ticket(db, 'fp-dup');
    createLink(db, { from_ticket: dup, to_ticket: mid, rel: 'duplicates', note: null });
    closeTicket(db, dup, { status: 'duplicate', resolution: 'same' }, { actor: 'x' });
    assert.deepEqual(shouldFile(db, 'fp-dup', live), {
      file: false,
      reason: 'tracked',
      ticketId: canonical,
    });

    // Its target fixed and closed: coming back is a regression.
    closeTicket(db, canonical, { status: 'closed', resolution: 'fixed' }, { actor: 'human' });
    assert.deepEqual(shouldFile(db, 'fp-dup', live), { file: true });

    // Fixed and closed itself: a regression too.
    const fixed = ticket(db, 'fp-fixed');
    closeTicket(db, fixed, { status: 'closed', resolution: 'fixed' }, { actor: 'human' });
    assert.deepEqual(shouldFile(db, 'fp-fixed', live), { file: true });

    // Wontfix: quiet while suppressed (closeTicket suppresses); after the
    // suppression TTL lapses the caller passes suppressed=false and it may come back.
    const won = ticket(db, 'fp-won');
    closeTicket(db, won, { status: 'wontfix', resolution: 'noise' }, { actor: 'human' });
    assert.deepEqual(shouldFile(db, 'fp-won', { suppressed: true, rate_spike: false }).file, false);
    assert.deepEqual(shouldFile(db, 'fp-won', live), { file: true });
  });
});
