import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAge, parseStoredTime } from './time.ts';

const NOON = Date.UTC(2026, 9, 5, 12, 0, 0);

test('parseStoredTime: both stored formats are UTC; the page copy agrees', async () => {
  const page = (await import(new URL('./ui/js/format.js', import.meta.url).href)) as {
    parseTs: (ts: string) => number | null;
  };
  for (const ts of [
    '2026-10-05 12:00:00',
    '2026-10-05T12:00:00.000Z',
    '2026-10-05T14:00:00+02:00',
  ]) {
    assert.equal(parseStoredTime(ts), NOON, ts);
    assert.equal(page.parseTs(ts), NOON, `page: ${ts}`);
  }
  assert.ok(Number.isNaN(parseStoredTime('nope')));
  assert.equal(page.parseTs('nope'), null);
});

test('formatAge: either format, never local time, never negative', () => {
  assert.equal(formatAge('2026-10-05 11:55:00', NOON), '5m');
  assert.equal(formatAge('2026-10-05T11:59:18.000Z', NOON), '42s');
  assert.equal(formatAge('2026-10-05 09:00:00', NOON), '3h');
  assert.equal(formatAge('2026-10-03T12:00:00.000Z', NOON), '2d');
  assert.equal(formatAge('2026-10-05 12:00:05', NOON), '0s', 'clock skew is not "-5s"');
});
