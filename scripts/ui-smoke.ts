/**
 * `npm run ui:smoke` — drive the real `lantern ui` in headless Chrome.
 *
 * Every scenario (ui-smoke/scenarios.ts) seeds its own throwaway LANTERN_DIR
 * (never ~/.lantern), starts `lantern ui` through the CLI on its own port, and
 * drives the page in one shared Chrome over the DevTools protocol — no
 * dependency. A seeded hostile ticket title must render as text and never
 * run. Needs Google Chrome; not part of `npm test` for that reason.
 *
 *   npm run ui:smoke                 every scenario
 *   npm run ui:smoke -- triage       only scenarios whose name contains "triage"
 *
 * Exit 0 = pass.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, CHROME, startUi } from './ui-smoke/harness.ts';
import { SCENARIOS } from './ui-smoke/scenarios.ts';
import { disposeWorld, seedWorld } from './ui-smoke/seed.ts';

const UI_PORT = 4477;

if (!existsSync(CHROME)) {
  console.error(`ui:smoke: Chrome not found at ${CHROME} (set CHROME=/path/to/chrome)`);
  process.exit(2);
}

const filter = process.argv[2];
const chosen = SCENARIOS.filter((s) => !filter || s.name.includes(filter));
if (chosen.length === 0) {
  console.error(
    `ui:smoke: no scenario matches '${filter}' — ${SCENARIOS.map((s) => s.name).join(', ')}`,
  );
  process.exit(2);
}
const results: Array<[string, boolean, string?]> = [];
const profile = mkdtempSync(join(tmpdir(), 'lantern-ui-smoke-chrome-'));
let browser: Browser | null = null;

try {
  browser = await Browser.launch(profile);
  for (const [i, scenario] of chosen.entries()) {
    // Its own port is its own origin: no localStorage carries over either.
    const port = UI_PORT + i;
    const w = seedWorld();
    let ui = startUi(w.lanternDir, w.fakeBin, port);
    const check = (name: string, pass: boolean, detail?: string) =>
      results.push([`[${scenario.name}] ${name}`, pass, detail]);
    try {
      const url = await ui.ready;
      await browser.open(url);
      await scenario.run({
        w,
        b: browser,
        url,
        check,
        killUi: () => ui.proc.kill('SIGKILL'),
        restartUi: async () => {
          ui = startUi(w.lanternDir, w.fakeBin, port);
          await ui.ready;
        },
      });
    } catch (e) {
      check('ran to completion', false, e instanceof Error ? e.message : String(e));
    } finally {
      ui.proc.kill('SIGKILL');
      disposeWorld(w);
    }
  }
} catch (e) {
  results.push(['smoke started', false, e instanceof Error ? e.message : String(e)]);
} finally {
  browser?.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Chrome may still be writing its profile; it is in tmp
  }
}

for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${!pass && detail ? `  — ${detail}` : ''}`);
}
const failed = results.filter(([, pass]) => !pass).length;
console.log(
  failed
    ? `\nui:smoke: ${failed} failed`
    : `\nui:smoke: all ${results.length} checks passed in ${chosen.length} scenarios`,
);
process.exit(failed || results.length === 0 ? 1 : 0);
