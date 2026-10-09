import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// `agent ↔ agent-config ↔ logs-scan ↔ store/pulses ↔ store/usage`
// was a cycle. Type imports count: they are erased at runtime, but a cycle
// through them is still a layering knot.
const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.includes('.test.') ? [p] : [];
  });
}

test('src has no import cycles, type imports included', () => {
  const graph = new Map<string, string[]>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    const deps = [...text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+'(\.[^']+\.ts)';/gm)].map(
      (m) => normalize(join(dirname(file), m[1] as string)),
    );
    graph.set(file, deps);
  }
  const cycles: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const visit = (n: string, path: string[]) => {
    state.set(n, 'open');
    for (const d of graph.get(n) ?? []) {
      if (state.get(d) === 'open') {
        cycles.push([...path.slice(path.indexOf(d)), d].map((p) => relative(SRC, p)).join(' → '));
      } else if (!state.has(d)) visit(d, [...path, d]);
    }
    state.set(n, 'done');
  };
  for (const n of graph.keys()) if (!state.has(n)) visit(n, [n]);
  assert.deepEqual(cycles, []);
});
