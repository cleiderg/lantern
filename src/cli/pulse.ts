/**
 * `lantern pulse --now [--dry-run]`: a manual daemon tick, or its gates and
 * digest only.
 * Split out of cli.ts's one `run()` function.
 */

import { ensureDefaultAgent, getAgent } from '../agent.ts';
import { type RuntimeSettings, runtimeSettings } from '../agent-config.ts';
import { openDb } from '../db.ts';
import { buildDigest } from '../digest.ts';
import { runGates } from '../gates.ts';
import { waitForCompletions } from '../harness/session-runner.ts';
import { runPulse } from '../pulse.ts';
import { computeWindow, getLastPulseWindowEnd } from '../scheduler.ts';

import { type CliCtx, flagValue, requireDb } from './shared.ts';

export function cmdPulse(c: CliCtx): number {
  const { argv, out, err, lanternDir } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  if (!argv.includes('--now')) {
    err.write('lantern pulse: --now is required\n');
    return 1;
  }

  const dryRun = argv.includes('--dry-run');
  const agentFlag = flagValue(argv, '--agent');
  const db = openDb(dbPath);
  const agent = agentFlag
    ? (() => {
        const found = getAgent(db, agentFlag);
        if (!found) {
          err.write(`lantern pulse: unknown agent '${agentFlag}'\n`);
          db.close();
          return null;
        }
        return found;
      })()
    : ensureDefaultAgent(db, lanternDir);
  if (!agent) return 1;
  const nowIso = new Date().toISOString();
  const window = computeWindow(getLastPulseWindowEnd(db, agent.id), nowIso);

  // --dry-run: gates + digest only, no pulse row and no collectors (they file
  // real tickets). A real manual pulse is a full tick — see runPulse below.
  if (dryRun) {
    // Same settings as a daemon tick: budget, quiet hours, allow_dirty.
    let settings: RuntimeSettings;
    try {
      settings = runtimeSettings(agent);
    } catch (e) {
      db.close();
      err.write(`lantern pulse: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }

    // --now is a manual override: respect the PAUSED file but not agent.state
    const gateResult = runGates(db, {
      lanternDir,
      agentId: agent.id,
      agentState: 'running',
      agentWorkdir: agent.workdir,
      agentMaxChildren: agent.max_children,
      dailyCeilingUsd: settings.dailyCeilingUsd,
      quietHours: settings.quietHours,
      allowDirty: settings.allowDirty,
    });

    if (!gateResult.ok) {
      db.close();
      err.write(`lantern pulse: gates failed — ${gateResult.reason}\n`);
      return 1;
    }

    const digest = buildDigest(
      db,
      agent,
      window,
      settings.dailyCeilingUsd,
      undefined,
      settings.config,
    );
    db.close();
    out.write(digest);
    out.write('\n── dry-run: digest built, orchestrator turn skipped ──\n');
    return 0;
  }

  // Non-dry-run: exactly a daemon tick (src/pulse.ts) — gates, collect,
  // turn, reap — except that a manual pulse needs no running daemon. This
  // process stays alive until the turn and every child it started are done.
  db.close();
  const pulseDb = openDb(dbPath);
  runPulse({
    db: pulseDb,
    lanternDir,
    agentId: agent.id,
    window,
    manual: true,
    harness: c.harness,
    childHarness: c.harness,
  })
    .then(async (r) => {
      if (r.kind === 'skipped') {
        err.write(`lantern pulse: gates failed — ${r.reason}\n`);
        process.exitCode = 1;
        return;
      }
      if (r.kind === 'error') {
        err.write(`lantern pulse: error — ${r.error}\n`);
        process.exitCode = 1;
        return;
      }
      out.write(`lantern: pulse ${r.pulseId} ${r.status} — cost=$${r.costUsd.toFixed(4)}\n`);
      await waitForCompletions();
    })
    .catch((e: unknown) => {
      err.write(`lantern pulse: error — ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    })
    .finally(() => pulseDb.close());
  return 0;
}
