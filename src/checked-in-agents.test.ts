import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAgentConfig } from './agent-config.ts';

// Never point the daemon at a real repo during development. An agent file in
// this repository is one `lantern agent add` away from running, so its workdir
// must be a throwaway one.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function agentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return agentFiles(p);
    return e.name.endsWith('.agent.md') ? [p] : [];
  });
}

test('no agent file in the repository points at a real repo', () => {
  const files = agentFiles(ROOT);
  assert.ok(files.length > 0, 'the example and fixture agents are found');
  for (const f of files) {
    const { workdir } = loadAgentConfig(f);
    assert.ok(
      workdir.startsWith('/tmp/'),
      `${relative(ROOT, f)}: workdir ${workdir} is not under /tmp/`,
    );
  }
});
