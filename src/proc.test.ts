import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execText, runWithDeadline } from './proc.ts';

test('execText: trimmed stdout; a failure throws with stderr', () => {
  assert.equal(execText('sh', ['-c', 'echo "  hi  "']), 'hi');
  assert.throws(
    () => execText('sh', ['-c', 'echo nope >&2; exit 3']),
    (e: { stderr?: string }) => String(e.stderr).includes('nope'),
  );
});

test('runWithDeadline: output, exit code, tail, deadline, missing program', async () => {
  const done = await runWithDeadline(['sh', '-c', 'echo out; echo err >&2; exit 2'], {
    cwd: '/tmp',
    timeoutMs: 5000,
  });
  assert.equal(done.code, 2);
  assert.equal(done.timedOut, false);
  assert.equal(done.stdout.trim(), 'out');
  assert.equal(done.stderr.trim(), 'err');
  assert.match(done.output, /out[\s\S]*err|err[\s\S]*out/);

  const tail = await runWithDeadline(['sh', '-c', 'printf 0123456789'], {
    cwd: '/tmp',
    timeoutMs: 5000,
    tail: 4,
  });
  assert.equal(tail.stdout, '6789');

  // group: the shell and its child are both killed at the deadline
  const slow = await runWithDeadline(['sh', '-c', 'sleep 30 & wait'], {
    cwd: '/tmp',
    timeoutMs: 200,
    group: true,
  });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.code, null);

  const missing = await runWithDeadline(['no-such-program-lantern'], {
    cwd: '/tmp',
    timeoutMs: 1000,
  });
  assert.equal(missing.code, null);
  assert.match(missing.error ?? '', /ENOENT/);
});
