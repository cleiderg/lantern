import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJUnit } from './junit.ts';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../test/fixtures/junit/${name}`, import.meta.url)),
    'utf8',
  );

test('parseJUnit: a real Surefire report — 18 passes with class#name ids and durations', () => {
  const r = parseJUnit(fixture('surefire-ownercontroller.xml'));
  assert.equal(r.length, 18);
  assert.ok(r.every((t) => t.outcome === 'pass'));
  assert.equal(
    r.find((t) => t.name === 'showOwner')?.testId,
    'org.springframework.samples.petclinic.owner.OwnerControllerTests#showOwner',
  );
  assert.equal(r.find((t) => t.name === 'showOwner')?.ms, 38);
});

test('parseJUnit: real Surefire skips carry their reason', () => {
  const r = parseJUnit(fixture('surefire-mysqlintegration.xml'));
  assert.deepEqual(
    r.map((t) => t.outcome),
    ['skip', 'skip'],
  );
  assert.match(r[0]?.message ?? '', /Docker is not available/);
});

test('parseJUnit: failure, error and a rerun flake — entities and CDATA decoded', () => {
  const r = parseJUnit(fixture('surefire-failure.xml'));
  const by = Object.fromEntries(r.map((t) => [t.name, t]));
  assert.equal(by.initCreationForm?.outcome, 'pass');
  assert.equal(by.initCreationFormWithUnknownOwner?.outcome, 'fail');
  assert.match(
    by.initCreationFormWithUnknownOwner?.message ?? '',
    /^Status expected:<404> but was:<500>/,
  );
  assert.match(by.initCreationFormWithUnknownOwner?.message ?? '', /PetControllerTests\.java:121/);
  assert.equal(by.processUpdateForm?.outcome, 'error');
  assert.match(by.processUpdateForm?.message ?? '', /Connection refused & gave up/);
  // Surefire reran it and it passed: a pass that flaked on the way.
  assert.equal(by.showPet?.outcome, 'pass');
  assert.equal(by.showPet?.flaky, true);
});

test('parseJUnit: pytest and jest-junit', () => {
  const py = parseJUnit(fixture('pytest.xml'));
  assert.deepEqual(
    py.map((t) => [t.testId, t.outcome]),
    [
      ['tests.test_sum#test_empty', 'pass'],
      ['tests.test_sum#test_negative', 'fail'],
      ['tests.test_sum#test_slow', 'skip'],
    ],
  );
  assert.match(py[1]?.message ?? '', /assert -1 == 1[\s\S]*> {7}assert total/);
  const jest = parseJUnit(fixture('jest-junit.xml'));
  assert.equal(jest.length, 2);
  assert.equal(jest[1]?.outcome, 'fail');
  assert.match(jest[1]?.message ?? '', /Received: undefined[\s\S]*Object\.<anonymous>/);
});

test('parseJUnit: a malformed file is an error, never an empty pass; a long message is cut', () => {
  assert.throws(() => parseJUnit(fixture('malformed.xml')), /JUnit/);
  assert.throws(() => parseJUnit('not xml at all'), /JUnit/);
  assert.throws(() => parseJUnit('<?xml version="1.0"?><html></html>'), /no <testsuite>/);
  const long = `<testsuite name="s"><testcase name="t" classname="C"><failure>${'x'.repeat(10_000)}</failure></testcase></testsuite>`;
  assert.ok((parseJUnit(long)[0]?.message.length ?? 0) <= 2000);
});
