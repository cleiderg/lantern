import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { notify } from './notify.ts';

/**
 * Every test injects platform + spawnFn explicitly. This is not just style —
 * it is load-bearing: without an injected spawnFn, notify() on this (darwin)
 * dev machine would fire a REAL system notification on every test run.
 */
function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & { unref: () => void };
  emitter.unref = () => {};
  return emitter;
}

test('notify: calls osascript with the title and message on darwin', () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return fakeChild();
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real ChildProcess
  }) as any;

  notify('Lantern: new escalation', 'Agent Joe needs your input', { platform: 'darwin', spawnFn });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, 'osascript');
  assert.equal(calls[0]?.args[0], '-e');
  assert.match(calls[0]?.args[1] ?? '', /display notification/);
  assert.match(calls[0]?.args[1] ?? '', /Agent Joe needs your input/);
  assert.match(calls[0]?.args[1] ?? '', /Lantern: new escalation/);
});

test('notify: does nothing on a non-darwin platform', () => {
  let called = false;
  const spawnFn = ((..._args: unknown[]) => {
    called = true;
    return fakeChild();
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real ChildProcess
  }) as any;

  notify('title', 'message', { platform: 'linux', spawnFn });
  assert.equal(called, false, 'must not spawn osascript off darwin');
});

test('notify: LANTERN_DISABLE_NOTIFY=1 suppresses even on darwin (defense in depth for test subprocesses)', () => {
  const prev = process.env.LANTERN_DISABLE_NOTIFY;
  process.env.LANTERN_DISABLE_NOTIFY = '1';
  try {
    let called = false;
    const spawnFn = ((..._args: unknown[]) => {
      called = true;
      return fakeChild();
      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real ChildProcess
    }) as any;

    notify('title', 'message', { platform: 'darwin', spawnFn });
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.LANTERN_DISABLE_NOTIFY;
    else process.env.LANTERN_DISABLE_NOTIFY = prev;
  }
});

test('notify: swallows a spawn failure rather than throwing', () => {
  const spawnFn = (() => {
    throw new Error('spawn ENOENT');
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real ChildProcess
  }) as any;

  assert.doesNotThrow(() => notify('title', 'message', { platform: 'darwin', spawnFn }));
});
