/**
 * Prior-art eval harness — precision@5 over labeled fixtures.
 *
 * Usage:  npm run eval:priorart
 * Exits 1 if overall precision@5 < PRECISION_THRESHOLD.
 *
 * Each fixture defines a small ticket corpus, a query, and the set of ticket
 * indices that are "relevant" prior art for that query.  We seed a fresh SQLite
 * DB per fixture, run priorArt(), and count how many of the top-K results are
 * in the relevant set.
 *
 * precision@K = |relevant ∩ top-K results| / min(K, |results|)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { initLantern } from '../src/init.ts';
import { priorArt } from '../src/store/prior-art.ts';
import { closeTicket, createTicket, setTicketFiles } from '../src/store/tickets.ts';
import type { EventContext, TicketKind, TicketOrigin } from '../src/types.ts';

// ── types ─────────────────────────────────────────────────────────────────────

type FixtureTicket = {
  kind: TicketKind;
  title: string;
  body: string;
  origin?: TicketOrigin;
  fingerprint?: string;
  files?: string[];
  close?: { status: 'closed' | 'wontfix' | 'duplicate'; resolution: string };
};

type Fixture = {
  name: string;
  tickets: FixtureTicket[];
  query: { title: string; body?: string; files?: string[]; fingerprint?: string | null };
  /** Indices into tickets[] that must appear in top-K results to count as a hit. */
  relevant: number[];
};

// ── config ────────────────────────────────────────────────────────────────────

const TOP_K = 5;
const PRECISION_THRESHOLD = 0.7;
const CTX: EventContext = { actor: 'eval' };

// ── fixtures ──────────────────────────────────────────────────────────────────

const fixtures: Fixture[] = [
  // 1 ── basic title match
  {
    name: 'basic title match',
    tickets: [
      {
        kind: 'bug',
        title: 'segfault in renderer',
        body: 'process crashes at startup with SIGSEGV',
      },
      { kind: 'chore', title: 'update CI pipeline', body: 'bump github actions to v4' },
      { kind: 'chore', title: 'refactor test helpers', body: 'consolidate fixture builders' },
    ],
    query: { title: 'segfault renderer crash startup' },
    relevant: [0],
  },

  // 2 ── relevant content lives in body, not title
  {
    name: 'body-text match',
    tickets: [
      {
        kind: 'bug',
        title: 'startup failure on cold boot',
        body: 'database connection pool exhausted during initialisation',
      },
      { kind: 'chore', title: 'lint rule update', body: 'add no-floating-promises rule' },
      { kind: 'bug', title: 'performance regression', body: 'query latency doubled after deploy' },
    ],
    query: { title: 'connection pool exhausted startup' },
    relevant: [0],
  },

  // 3 ── prior art discoverable only via its resolution text
  {
    name: 'resolution-text match',
    tickets: [
      {
        kind: 'bug',
        title: 'rate limiter too aggressive',
        body: 'requests blocked at 80% capacity',
        close: {
          status: 'closed',
          resolution: 'increased token bucket refill rate by factor of two',
        },
      },
      { kind: 'bug', title: 'auth failure spike', body: 'high 401 error rate in access logs' },
      { kind: 'chore', title: 'bump node version', body: 'upgrade to Node 24 LTS' },
    ],
    query: { title: 'token bucket rate refill limiter' },
    relevant: [0],
  },

  // 4 ── closed+resolved tickets surface alongside open ones on the same topic
  {
    name: 'closed+resolved bias',
    tickets: [
      { kind: 'bug', title: 'memory leak in cache layer', body: 'heap grows unbounded under load' },
      { kind: 'bug', title: 'memory leak in cache layer', body: 'heap grows unbounded under load' },
      {
        kind: 'bug',
        title: 'memory leak in cache layer',
        body: 'heap grows unbounded under load',
        close: { status: 'closed', resolution: 'bounded LRU eviction queue at 10k entries' },
      },
      { kind: 'chore', title: 'reformat markdown docs', body: 'apply prettier to all md files' },
    ],
    query: { title: 'memory leak cache heap unbounded' },
    relevant: [0, 1, 2],
  },

  // 5 ── wontfix decision recorded as prior art
  {
    name: 'wontfix bias — design decision as prior art',
    tickets: [
      {
        kind: 'bug',
        title: 'login session timeout too short',
        body: 'users logged out unexpectedly after inactivity',
      },
      {
        kind: 'bug',
        title: 'login session timeout too short',
        body: 'users logged out unexpectedly after inactivity',
        close: {
          status: 'wontfix',
          resolution: 'by design — 30 min timeout is a security requirement',
        },
      },
      {
        kind: 'chore',
        title: 'update eslint config',
        body: 'enable stricter rules for new modules',
      },
    ],
    query: { title: 'login session timeout' },
    relevant: [0, 1],
  },

  // 6 ── file-overlap boost raises the path-sharing ticket
  {
    name: 'file-overlap boost',
    tickets: [
      {
        kind: 'bug',
        title: 'cache invalidation race condition',
        body: 'stale data returned after write',
        files: ['src/cache/store.ts', 'src/cache/evict.ts'],
      },
      {
        kind: 'bug',
        title: 'cache invalidation race condition',
        body: 'stale data returned after write',
      },
      { kind: 'chore', title: 'add integration tests', body: 'cover happy path for all endpoints' },
    ],
    query: { title: 'cache invalidation stale race', files: ['src/cache/store.ts'] },
    relevant: [0, 1],
  },

  // 7 ── exact fingerprint boost
  {
    name: 'exact fingerprint boost',
    tickets: [
      {
        kind: 'bug',
        title: 'null pointer in auth handler',
        body: 'NPE when bearer token is absent',
        fingerprint: 'sha1:d4e5f6',
      },
      {
        kind: 'bug',
        title: 'null pointer in auth handler',
        body: 'NPE when bearer token is absent',
      },
      { kind: 'bug', title: 'disk quota exceeded', body: 'ENOSPC on log write under heavy load' },
    ],
    query: { title: 'null pointer auth bearer token', fingerprint: 'sha1:d4e5f6' },
    relevant: [0, 1],
  },

  // 8 ── porter stemmer — inflected forms in query match base forms in docs
  {
    name: 'porter stemming — inflected forms match',
    tickets: [
      {
        kind: 'bug',
        title: 'renderer crashes on launch',
        body: 'GPU process terminated during rendering startup',
      },
      {
        kind: 'chore',
        title: 'update package lock',
        body: 'regenerate lockfile after merge conflict',
      },
      {
        kind: 'bug',
        title: 'network request timeout',
        body: 'socket read operation hangs indefinitely',
      },
    ],
    // "rendering"→"render" matches "renderer"; "crashed"→"crash" matches "crashes"
    query: { title: 'rendering crashed launching GPU' },
    relevant: [0],
  },

  // 9 ── multiple relevant priors on the same topic should all surface
  {
    name: 'multi-relevant — several priors on same topic',
    tickets: [
      {
        kind: 'bug',
        title: 'ssl handshake failure',
        body: 'TLS ssl connection refused during handshake',
      },
      {
        kind: 'bug',
        title: 'tls certificate validation failure',
        body: 'ssl handshake rejected certificate',
      },
      {
        kind: 'bug',
        title: 'ssl protocol mismatch',
        body: 'TLS ssl handshake version alert received',
      },
      {
        kind: 'chore',
        title: 'bump npm dependencies',
        body: 'update all packages to latest version',
      },
      { kind: 'bug', title: 'disk quota exceeded', body: 'ENOSPC returned by kernel on write' },
    ],
    // "ssl" and "handshake" appear in tickets 0–2 but not in noise
    query: { title: 'ssl handshake' },
    relevant: [0, 1, 2],
  },

  // 10 ── combined boost: file overlap + closed bias, noise unrelated
  {
    name: 'combined boost — file overlap and closed bias',
    tickets: [
      { kind: 'bug', title: 'http request timeout', body: 'client hangs on outbound request' },
      {
        kind: 'bug',
        title: 'http request timeout',
        body: 'client hangs on outbound request',
        close: {
          status: 'closed',
          resolution: 'added deadline context to all outbound http calls',
        },
      },
      {
        kind: 'bug',
        title: 'http request timeout',
        body: 'client hangs on outbound request',
        files: ['src/http/client.ts'],
      },
      { kind: 'chore', title: 'clean up old migrations', body: 'remove no-op migration files' },
    ],
    query: { title: 'http request timeout client', files: ['src/http/client.ts'] },
    relevant: [0, 1, 2],
  },

  // 11 ── duplicate status gets bias; still surfaces as useful prior art
  {
    name: 'duplicate status — surfaces as prior art',
    tickets: [
      {
        kind: 'bug',
        title: 'LDAP login auth provider timeout',
        body: 'LDAP reconnect fails, directory service timeout',
      },
      {
        kind: 'bug',
        title: 'login fails with LDAP auth error',
        body: 'LDAP provider timeout on reconnect attempt',
        close: { status: 'duplicate', resolution: 'duplicate of #42 — LDAP reconnect timeout' },
      },
      { kind: 'chore', title: 'add prometheus metrics', body: 'instrument all route handlers' },
    ],
    query: { title: 'LDAP login auth timeout reconnect' },
    relevant: [0, 1],
  },

  // 12 ── collector-filed ticket retrieved by a human-phrased query
  {
    name: 'collector origin — log-filed ticket retrieved by human query',
    tickets: [
      {
        kind: 'bug',
        title: 'disk write failure fsync error',
        body: 'fsync syscall returns ENOSPC under load',
        origin: 'collector:logs',
      },
      {
        kind: 'bug',
        title: 'disk write failure fsync error',
        body: 'async flush disabled after fsync failure',
        origin: 'collector:email',
        close: { status: 'closed', resolution: 'switched to async flush with write-back queue' },
      },
      {
        kind: 'enhancement',
        title: 'add prometheus disk metrics',
        body: 'expose disk usage counters',
      },
    ],
    query: { title: 'disk write fsync failure error' },
    relevant: [0, 1],
  },

  // 13 ── narrow query targets one specific ticket over near-misses
  {
    name: 'specificity — narrow query targets the right ticket',
    tickets: [
      {
        kind: 'bug',
        title: 'generic API error handler',
        body: 'returns 500 for all unhandled errors',
      },
      {
        kind: 'bug',
        title: 'payment webhook HMAC validation failure',
        body: 'HMAC signature mismatch on Stripe payment webhook event',
      },
      {
        kind: 'bug',
        title: 'API error response missing detail',
        body: 'error body lacks stack trace in production',
      },
      {
        kind: 'chore',
        title: 'refactor billing module',
        body: 'extract payment logic into service layer',
      },
    ],
    query: { title: 'payment webhook HMAC signature Stripe mismatch' },
    relevant: [1],
  },

  // 14 ── mixed kinds (bug, enhancement, chore) on the same topic all retrieved
  {
    name: 'kind diversity — bugs and chores on same topic',
    tickets: [
      {
        kind: 'bug',
        title: 'database migration fails on rollback',
        body: 'schema change breaks foreign key constraint during migration rollback',
      },
      {
        kind: 'enhancement',
        title: 'add database migration rollback support',
        body: 'allow reverting schema migration safely',
      },
      {
        kind: 'chore',
        title: 'test migration runner edge cases',
        body: 'cover schema migration failure paths and rollback',
      },
      {
        kind: 'bug',
        title: 'socket connection timeout',
        body: 'TCP keep-alive misconfigured on client',
      },
    ],
    // drop "database" — ticket 2 has migration/schema/rollback but not "database"
    query: { title: 'migration schema rollback' },
    relevant: [0, 1, 2],
  },

  // 15 ── more shared file paths = larger boost
  {
    name: 'multi-file overlap — more shared paths = higher boost',
    tickets: [
      {
        kind: 'bug',
        title: 'cache write-through consistency bug',
        body: 'read returns stale value after cache write',
        files: ['src/cache/store.ts', 'src/cache/evict.ts', 'src/cache/index.ts'],
      },
      {
        kind: 'bug',
        title: 'cache write-through consistency bug',
        body: 'read returns stale value after cache write',
        files: ['src/cache/store.ts'],
      },
      {
        kind: 'bug',
        title: 'cache write-through consistency bug',
        body: 'read returns stale value after cache write',
      },
      {
        kind: 'chore',
        title: 'update linting rules',
        body: 'enable biome strict mode across the project',
      },
    ],
    query: {
      title: 'cache write stale read consistency',
      files: ['src/cache/store.ts', 'src/cache/evict.ts', 'src/cache/index.ts'],
    },
    relevant: [0, 1, 2],
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

type FixtureResult = {
  precision: number;
  hits: number;
  returned: number;
  expected: number;
};

function evalFixture(fixture: Fixture): FixtureResult {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-eval-'));
  try {
    const lanternDir = join(dir, '.lantern');
    initLantern(lanternDir);
    const db = openDb(join(lanternDir, 'lantern.db'));
    try {
      db.prepare(
        `INSERT INTO agents (id, display_name, config_path, mission, workdir)
         VALUES ('eval', 'Eval', 'agents/eval.agent.md', 'Eval', '/tmp')`,
      ).run();

      const ids: number[] = [];
      for (const t of fixture.tickets) {
        const id = createTicket(
          db,
          {
            kind: t.kind,
            title: t.title,
            body: t.body,
            origin: t.origin ?? 'human',
            fingerprint: t.fingerprint,
          },
          CTX,
        );
        if (t.files) setTicketFiles(db, id, t.files);
        if (t.close) closeTicket(db, id, t.close, CTX);
        ids.push(id);
      }

      const relevantIds = new Set(
        fixture.relevant.map((i) => {
          const id = ids[i];
          if (id === undefined)
            throw new Error(`fixture "${fixture.name}": index ${i} out of bounds`);
          return id;
        }),
      );
      const results = priorArt(db, fixture.query, { limit: TOP_K });
      const returnedIds = new Set(results.map((r) => r.id));

      const hits = [...relevantIds].filter((id) => returnedIds.has(id)).length;
      const returned = results.length;
      const expected = relevantIds.size;
      // If nothing was returned and nothing was expected → trivially correct.
      const precision =
        returned === 0 ? (expected === 0 ? 1.0 : 0.0) : hits / Math.min(TOP_K, returned);

      return { precision, hits, returned, expected };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

let totalPrecision = 0;
let passCount = 0;
const nameWidth = Math.max(...fixtures.map((f) => f.name.length));

for (const fixture of fixtures) {
  const { precision, hits, returned, expected } = evalFixture(fixture);
  const pass = precision >= PRECISION_THRESHOLD;
  const label = pass ? ' ok ' : 'FAIL';
  const pct = `${(precision * 100).toFixed(0).padStart(3)}%`;
  const detail = `(${hits}/${Math.min(TOP_K, returned)} in top-${TOP_K}, ${expected} expected)`;
  console.log(`${label}  [${pct}]  ${fixture.name.padEnd(nameWidth)}  ${detail}`);
  totalPrecision += precision;
  if (pass) passCount++;
}

const overall = totalPrecision / fixtures.length;
console.log();
console.log(
  `precision@${TOP_K}: ${(overall * 100).toFixed(1)}%` +
    `  (${passCount}/${fixtures.length} fixtures ≥ ${(PRECISION_THRESHOLD * 100).toFixed(0)}%)`,
);

if (overall < PRECISION_THRESHOLD) {
  console.error(`\nbelow threshold (${(PRECISION_THRESHOLD * 100).toFixed(0)}%) — exiting 1`);
  process.exit(1);
}
