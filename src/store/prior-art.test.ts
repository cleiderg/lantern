import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import type { EventContext } from '../types.ts';
import { getLinks } from './links.ts';
import { priorArt } from './prior-art.ts';
import { closeTicket, createTicket, setTicketFiles } from './tickets.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-pa-test-'));
  try {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
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

const CTX: EventContext = { actor: 'test' };

// ─── basic FTS ────────────────────────────────────────────────────────────────

test('priorArt returns empty array when no tickets match', () => {
  withDb((db) => {
    createTicket(
      db,
      { kind: 'bug', title: 'unrelated topic', body: 'nothing here', origin: 'human' },
      CTX,
    );
    const results = priorArt(db, { title: 'database crash' });
    assert.equal(results.length, 0);
  });
});

test('priorArt returns empty array on empty query', () => {
  withDb((db) => {
    const results = priorArt(db, { title: '' });
    assert.equal(results.length, 0);
  });
});

test('priorArt returns matching tickets', () => {
  withDb((db) => {
    createTicket(
      db,
      { kind: 'bug', title: 'segfault in renderer', body: 'crashes on launch', origin: 'human' },
      CTX,
    );
    createTicket(
      db,
      { kind: 'bug', title: 'disk full error', body: 'disk quota exceeded', origin: 'human' },
      CTX,
    );

    const results = priorArt(db, { title: 'segfault renderer crash' });
    assert.ok(results.length > 0);
    assert.equal(results[0]?.title, 'segfault in renderer');
  });
});

test('priorArt respects the limit', () => {
  withDb((db) => {
    for (let i = 0; i < 8; i++) {
      createTicket(
        db,
        {
          kind: 'bug',
          title: `network timeout error ${i}`,
          body: 'connection refused',
          origin: 'human',
        },
        CTX,
      );
    }
    const results = priorArt(db, { title: 'network timeout error' }, { limit: 3 });
    assert.ok(results.length <= 3);
  });
});

// ─── closed+resolution bias ───────────────────────────────────────────────────

test('closed+resolved ticket outranks open tickets with equal text match', () => {
  withDb((db) => {
    // Seed several open tickets on the same topic.
    for (let i = 0; i < 4; i++) {
      createTicket(
        db,
        {
          kind: 'bug',
          title: 'memory leak in cache layer',
          body: 'heap grows unbounded under load',
          origin: 'human',
        },
        CTX,
      );
    }

    // One closed+resolved ticket on the same topic — should rank #1 due to 2× boost.
    const closedId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'memory leak in cache layer',
        body: 'heap grows unbounded under load',
        origin: 'human',
      },
      CTX,
    );
    closeTicket(
      db,
      closedId,
      { status: 'closed', resolution: 'fixed by bounding the LRU eviction queue' },
      CTX,
    );

    const results = priorArt(db, { title: 'memory leak cache', body: 'heap unbounded' });
    assert.ok(results.length > 0, 'should return results');
    assert.equal(results[0]?.id, closedId, 'closed+resolved ticket should rank #1');
    assert.equal(results[0]?.status, 'closed');
    assert.ok(results[0]?.resolution?.includes('LRU'));
  });
});

test('wontfix+resolved ticket also outranks open tickets', () => {
  withDb((db) => {
    createTicket(
      db,
      {
        kind: 'bug',
        title: 'login timeout too short',
        body: 'session expires unexpectedly',
        origin: 'human',
      },
      CTX,
    );
    createTicket(
      db,
      {
        kind: 'bug',
        title: 'login timeout too short',
        body: 'session expires unexpectedly',
        origin: 'human',
      },
      CTX,
    );

    const wontfixId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'login timeout too short',
        body: 'session expires unexpectedly',
        origin: 'human',
      },
      CTX,
    );
    closeTicket(
      db,
      wontfixId,
      { status: 'wontfix', resolution: 'by design — security requirement' },
      CTX,
    );

    const results = priorArt(db, { title: 'login timeout session' });
    assert.equal(results[0]?.id, wontfixId);
    assert.equal(results[0]?.status, 'wontfix');
  });
});

test('open ticket with no resolution does NOT get the 2× bias', () => {
  withDb((db) => {
    const openId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'disk write failure',
        body: 'fsync fails under heavy load',
        origin: 'human',
      },
      CTX,
    );
    const closedId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'disk write failure',
        body: 'fsync fails under heavy load',
        origin: 'human',
      },
      CTX,
    );
    closeTicket(db, closedId, { status: 'closed', resolution: 'patched fsync retry logic' }, CTX);

    const results = priorArt(db, { title: 'disk write fsync failure' });
    // closedId should rank above openId
    const closedRank = results.findIndex((r) => r.id === closedId);
    const openRank = results.findIndex((r) => r.id === openId);
    assert.ok(closedRank < openRank, `closed (#${closedId}) should rank above open (#${openId})`);
  });
});

// ─── result fields ────────────────────────────────────────────────────────────

test('priorArt result includes id, title, status, resolution, score', () => {
  withDb((db) => {
    const id = createTicket(
      db,
      {
        kind: 'bug',
        title: 'ssl handshake failure',
        body: 'tls negotiation fails',
        origin: 'human',
      },
      CTX,
    );
    closeTicket(db, id, { status: 'closed', resolution: 'updated cert bundle' }, CTX);

    const results = priorArt(db, { title: 'ssl handshake' });
    assert.ok(results.length > 0);
    const [r] = results;
    assert.ok(r);
    assert.equal(typeof r.id, 'number');
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.status, 'string');
    assert.equal(typeof r.score, 'number');
    assert.ok(r.score < 0, 'BM25 score should be negative');
    assert.equal(r.resolution, 'updated cert bundle');
  });
});

// ─── fromTicketId exclusion + auto-link ───────────────────────────────────────

test('priorArt excludes the querying ticket from results', () => {
  withDb((db) => {
    const selfId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'cache eviction bug',
        body: 'items evicted too early',
        origin: 'human',
      },
      CTX,
    );
    createTicket(
      db,
      {
        kind: 'bug',
        title: 'cache eviction problem',
        body: 'stale items persist',
        origin: 'human',
      },
      CTX,
    );

    const results = priorArt(db, { title: 'cache eviction' }, { fromTicketId: selfId, ctx: CTX });
    assert.ok(
      results.every((r) => r.id !== selfId),
      'self ticket should not appear in results',
    );
  });
});

// ─── file-overlap boost ─────────────────────────────────────────────────

test('file-overlap boost ranks shared-path ticket above text-only match at equal text score', () => {
  withDb((db) => {
    // Two tickets with identical text so BM25 is equal.
    const title = 'cache invalidation bug';
    const body = 'stale data served after write';

    const withFileId = createTicket(db, { kind: 'bug', title, body, origin: 'human' }, CTX);
    setTicketFiles(db, withFileId, ['src/cache/store.ts', 'src/cache/evict.ts']);

    const withoutFileId = createTicket(db, { kind: 'bug', title, body, origin: 'human' }, CTX);
    // no files for this ticket

    const results = priorArt(db, { title, body, files: ['src/cache/store.ts'] });

    assert.ok(results.length >= 2, 'both tickets should match');
    const withFileRank = results.findIndex((r) => r.id === withFileId);
    const withoutFileRank = results.findIndex((r) => r.id === withoutFileId);
    assert.ok(
      withFileRank < withoutFileRank,
      `ticket with shared file (#${withFileId}) should rank above text-only (#${withoutFileId})`,
    );
  });
});

test('exact fingerprint boost ranks matching ticket above text-only at equal text score', () => {
  withDb((db) => {
    const title = 'null pointer in auth handler';
    const body = 'crashes when token is missing';

    const fpId = createTicket(
      db,
      { kind: 'bug', title, body, origin: 'human', fingerprint: 'sha1:abc123' },
      CTX,
    );

    const noFpId = createTicket(db, { kind: 'bug', title, body, origin: 'human' }, CTX);

    const results = priorArt(db, { title, body, fingerprint: 'sha1:abc123' });

    assert.ok(results.length >= 2, 'both tickets should match');
    const fpRank = results.findIndex((r) => r.id === fpId);
    const noFpRank = results.findIndex((r) => r.id === noFpId);
    assert.ok(
      fpRank < noFpRank,
      `fingerprint-matching ticket (#${fpId}) should rank above non-matching (#${noFpId})`,
    );
  });
});

test('priorArt with no files or fingerprint behaves identically to prior queries', () => {
  withDb((db) => {
    createTicket(
      db,
      { kind: 'bug', title: 'render pipeline crash', body: 'gpu driver fault', origin: 'human' },
      CTX,
    );
    const results = priorArt(db, { title: 'render pipeline crash' });
    assert.ok(results.length > 0);
    assert.equal(results[0]?.title, 'render pipeline crash');
  });
});

test('priorArt auto-writes relates_to links for strong matches when fromTicketId+ctx provided', () => {
  withDb((db) => {
    // Create a closed+resolved ticket that will score strongly.
    const priorId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'database connection pool exhausted',
        body: 'pool hits max connections',
        origin: 'human',
      },
      CTX,
    );
    closeTicket(
      db,
      priorId,
      { status: 'closed', resolution: 'increased pool size and added timeout' },
      CTX,
    );

    // New ticket requesting prior art.
    const newId = createTicket(
      db,
      {
        kind: 'bug',
        title: 'connection pool exhausted',
        body: 'database pool max connections reached',
        origin: 'human',
      },
      CTX,
    );

    priorArt(
      db,
      { title: 'connection pool exhausted', body: 'database pool max connections' },
      { fromTicketId: newId, ctx: CTX, linkThreshold: 0 }, // link any BM25 match regardless of corpus size
    );

    const links = getLinks(db, newId);
    assert.ok(links.length > 0, 'a relates_to link should have been auto-written');
    assert.ok(links.some((l) => l.to_ticket === priorId && l.rel === 'relates_to'));
  });
});

test('priorArt: dotted names and code in a title still match (Servlet.service(), foo_bar)', () => {
  withDb((db) => {
    const title =
      '[logs] Servlet.service() for servlet [dispatcherServlet] threw exception [Request processing failed: java.lang.IllegalArgumentException: Owner not found]';
    const first = createTicket(
      db,
      { kind: 'bug', title, body: 'b', origin: 'collector:logs' },
      CTX,
    );
    const second = createTicket(
      db,
      { kind: 'bug', title, body: 'b', origin: 'collector:logs' },
      CTX,
    );
    const hits = priorArt(db, { title }, { fromTicketId: second });
    assert.deepEqual(
      hits.map((h) => h.id),
      [first],
      'the identical earlier ticket is found',
    );
  });
});
