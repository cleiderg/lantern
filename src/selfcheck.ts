import type Database from 'better-sqlite3';
import { writePulseFinding } from './store/pulses.ts';

export type SelfcheckResult = {
  healthy: boolean;
  problems: string[];
};

/**
 * The `heartbeat.selfcheck` every-pulse action (a "trivial built-in"
 * action, wired to `playbook_run`, "heartbeat.selfcheck
 * resolved as a real playbook"). Verifies what the orchestrator can actually
 * observe from inside one MCP call: the schema is migrated, and this pulse's
 * own row is `running`. Writes its own `pulse_finding` (same pattern as
 * `scanLogs`/`scanInbox`), so the caller need only relay the result.
 *
 * Assumes `pulseId` refers to a real row — `pulse_findings.pulse_id` is a
 * foreign key, so a nonexistent pulse can't be written to. The caller (as
 * with `logs.scan`/`inbox.bugs`) is responsible for that existence check
 * before calling in.
 */
export function runHeartbeatSelfcheck(db: Database.Database, pulseId: number): SelfcheckResult {
  const problems: string[] = [];

  const migrations = db.prepare('SELECT count(*) as n FROM schema_migrations').get() as {
    n: number;
  };
  if (migrations.n === 0) problems.push('no rows in schema_migrations — migrations not applied');

  const pulse = db.prepare('SELECT status FROM pulses WHERE id = ?').get(pulseId) as
    | { status: string }
    | undefined;
  if (pulse && pulse.status !== 'running') {
    problems.push(`pulse #${pulseId} status is '${pulse.status}', expected 'running'`);
  }

  const healthy = problems.length === 0;
  writePulseFinding(db, {
    pulseId,
    actionKey: 'heartbeat.selfcheck',
    outcome: healthy ? 'clean' : 'error',
    detail: healthy ? 'schema migrated, pulse row live — daemon healthy' : problems.join('; '),
  });

  return { healthy, problems };
}
