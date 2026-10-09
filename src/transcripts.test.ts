import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  orchestratorTranscriptPath,
  sessionTranscriptPath,
  summarizeTranscript,
} from './transcripts.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'lantern-tr-'));
  dirs.push(d);
  return d;
};

const FIXTURE = fileURLToPath(new URL('../test/fixtures/transcript.jsonl', import.meta.url));

test('transcript paths: runs/<pulse>/orchestrator.jsonl and runs/<pulse>/<session>.jsonl', () => {
  assert.equal(orchestratorTranscriptPath('/l', 7), '/l/runs/7/orchestrator.jsonl');
  assert.equal(sessionTranscriptPath('/l', 7, 'abc'), '/l/runs/7/abc.jsonl');
  // A session id is a path segment: never let one climb out of runs/.
  assert.throws(() => sessionTranscriptPath('/l', 7, '../../etc/passwd'), /session id/);
});

test('summarizeTranscript: init, calls, results, denials and cost; bad lines are counted, not fatal', () => {
  const t = summarizeTranscript(FIXTURE);
  assert.ok(t);
  assert.deepEqual(t.init, {
    model: 'claude-opus-5-5',
    permissionMode: 'acceptEdits',
    tools: ['Bash', 'Edit', 'Read', 'mcp__lantern__tickets_get'],
    mcpServers: ['lantern'],
  });
  assert.deepEqual(
    t.steps.map((s) => s.kind),
    ['text', 'call', 'result', 'call', 'result'],
  );
  assert.deepEqual(t.steps[1], { kind: 'call', tool: 'Bash', input: 'cat sum.js' });
  assert.deepEqual(t.steps[4], {
    kind: 'result',
    isError: true,
    text: 'Permission to use Bash with command git push origin HEAD:main has been denied.',
  });
  assert.deepEqual(t.denials, [{ tool: 'Bash', input: 'git push origin HEAD:main' }]);
  assert.deepEqual(t.end, {
    subtype: 'success',
    costUsd: 0.12,
    turns: 3,
    result: 'Fixed it; the push to main was denied.',
  });
  assert.equal(t.unparsedLines, 1);
});

test('summarizeTranscript: a missing file is null, not a throw', () => {
  assert.equal(summarizeTranscript('/nonexistent/x.jsonl'), null);
});

test('summarizeTranscript from an offset: only new complete lines; a half-written line waits', () => {
  const path = join(scratch(), 's.jsonl');
  const lines = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const call = lines.find((l) => l.includes('"tool_use"')) as string;
  writeFileSync(path, `${lines[0]}\n`);
  const first = summarizeTranscript(path);
  assert.ok(first?.init);
  assert.equal(first.steps.length, 0);
  assert.equal(first.nextOffset, Buffer.byteLength(`${lines[0]}\n`));

  // The child is mid-write: half a line is not a step yet, nor an unparsed line.
  appendFileSync(path, call.slice(0, 20));
  const mid = summarizeTranscript(path, first.nextOffset);
  assert.equal(mid?.steps.length, 0);
  assert.equal(mid?.unparsedLines, 0);
  assert.equal(mid?.nextOffset, first.nextOffset);

  appendFileSync(path, `${call.slice(20)}\n`);
  const next = summarizeTranscript(path, mid?.nextOffset);
  assert.equal(next?.init, null, 'init is not re-read');
  assert.deepEqual(
    next?.steps.map((s) => s.kind),
    ['text', 'call'],
  );
  assert.equal(next?.reset, false);

  // A file shorter than the offset was replaced: start over, and say so.
  writeFileSync(path, `${lines[0]}\n`);
  const again = summarizeTranscript(path, 10_000);
  assert.equal(again?.reset, true);
  assert.ok(again?.init);
});

test('summarizeTranscript: a final line with no newline is read once it is whole JSON', () => {
  const path = join(scratch(), 's.jsonl');
  const text = readFileSync(FIXTURE, 'utf8').trimEnd();
  writeFileSync(path, text);
  const t = summarizeTranscript(path);
  assert.ok(t?.end, 'the result event on the last line is read');
  assert.equal(t.nextOffset, Buffer.byteLength(text));
});
