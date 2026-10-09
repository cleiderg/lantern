/**
 * The ticket and session status vocabularies live in
 * one place — types.ts (and its mirror ui/js/vocab.js for the page, which has
 * no build step). These tests hold the copies to the schema and to each other,
 * and fail if a literal copy of a list reappears anywhere else.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIVE_SESSION_STATUSES,
  LIVE_SQL,
  SESSION_STATUSES,
  TERMINAL_SQL,
  TERMINAL_TICKET_STATUSES,
  TICKET_STATUSES,
} from './types.ts';

// A computed specifier: the page's .js module has no type declarations.
const pageVocab = await import(new URL('./ui/js/vocab.js', import.meta.url).href);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const schema = readFileSync(join(ROOT, 'migrations/001_init.sql'), 'utf8');

/** The values of `<table>`'s `status ... CHECK (status IN (...))` in 001_init.sql. */
function schemaStatuses(table: string): string[] {
  const body = schema.slice(schema.indexOf(`CREATE TABLE ${table} (`));
  const m = /status\s+TEXT[^,]*?CHECK \(status IN\s*\(([^)]*)\)\)/s.exec(body);
  assert.ok(m, `no status CHECK on ${table}`);
  return [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

test('vocab: the status lists match the schema', () => {
  assert.deepEqual([...TICKET_STATUSES], schemaStatuses('tickets'));
  assert.deepEqual([...SESSION_STATUSES], schemaStatuses('sessions'));
  for (const s of TERMINAL_TICKET_STATUSES) assert.ok(TICKET_STATUSES.includes(s), s);
  for (const s of LIVE_SESSION_STATUSES) assert.ok(SESSION_STATUSES.includes(s), s);
  assert.equal(TERMINAL_SQL, "('closed','wontfix','duplicate')");
  assert.equal(LIVE_SQL, "('starting','running','waiting')");
});

test('vocab: the page mirror equals types.ts', () => {
  assert.deepEqual(pageVocab.TICKET_STATUSES, [...TICKET_STATUSES]);
  assert.deepEqual(pageVocab.TERMINAL_TICKET_STATUSES, [...TERMINAL_TICKET_STATUSES]);
  assert.deepEqual(pageVocab.LIVE_SESSION_STATUSES, [...LIVE_SESSION_STATUSES]);
});

test('vocab: no literal copy of a status list outside types.ts and vocab.js', () => {
  const copy = /'closed',\s*'wontfix',\s*'duplicate'|'starting',\s*'running',\s*'waiting'/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(f) && !/\.test\.ts$/.test(f)) {
        const rel = p.slice(ROOT.length);
        if (rel === 'src/types.ts' || rel === 'src/ui/js/vocab.js') continue;
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (copy.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(offenders, [], 'use the constants from types.ts (or ui/js/vocab.js)');
});
