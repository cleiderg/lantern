/**
 * Read-only reports: `status`, `metrics`, `sessions`, `logs`.
 * Split out of cli.ts's one `run()` function.
 */

import { existsSync } from 'node:fs';
import { listAgents } from '../agent.ts';
import { DEFAULT_DAILY_CEILING_USD } from '../budget.ts';
import { openDb } from '../db.ts';
import { checkDeadMan } from '../deadman.ts';
import { formatMetrics } from '../format.ts';
import { computeMetrics } from '../store/metrics.ts';
import { getLiveChildrenCount, getPulseFindings, getRecentPulses } from '../store/pulses.ts';
import { listSessions } from '../store/sessions.ts';
import { getDailyUsage, utcDay } from '../store/usage.ts';
import { formatAge } from '../time.ts';
import { orchestratorTranscriptPath } from '../transcripts.ts';
import type { Session } from '../types.ts';

import { type CliCtx, flagValue, requireDb } from './shared.ts';

export function cmdStatus(c: CliCtx): number {
  const { out } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    const agents = listAgents(db);
    if (agents.length === 0) {
      out.write('no agents — run `lantern start` to initialize\n');
    } else {
      out.write(`Agents (${agents.length}):\n`);
      for (const a of agents) {
        const last = a.last_pulse_at ? a.last_pulse_at.slice(0, 16) : 'never';
        out.write(
          `  ${a.id.padEnd(12)}  ${a.display_name.padEnd(16)}  [${a.state}]  heartbeat=${a.heartbeat_seconds}s  last_pulse=${last}\n`,
        );
        // Dead-man alert: only meaningful for an agent that should
        // currently be pulsing — a paused/stopped/tripped agent isn't.
        if (a.state === 'running') {
          const deadman = checkDeadMan(a, Date.now());
          if (deadman.stale) {
            out.write(
              `  ⚠ ${a.id}: no pulse in ${deadman.staleSeconds}s (>${deadman.thresholdSeconds}s = 3× heartbeat) — daemon may be stuck or dead\n`,
            );
          }
        }
      }

      const pulses = agents.flatMap((a) => getRecentPulses(db, a.id, 24));
      if (pulses.length > 0) {
        out.write(`\nPulses (last 24h, ${pulses.length}):\n`);
        for (const p of pulses) {
          const start = p.window_start.slice(0, 16);
          const end = p.window_end.slice(0, 16);
          const findings = getPulseFindings(db, p.id);
          const findingStr =
            findings.length > 0
              ? findings.map((f) => `${f.action_key}:${f.outcome}`).join(', ')
              : '(no findings)';
          out.write(
            `  #${String(p.id).padEnd(4)}  [${p.status.padEnd(9)}]  ${start} → ${end}  ${findingStr}\n`,
          );
        }
      }

      // Morning screen summary: spend / sessions / escalations
      const today = utcDay();
      const dailyCeilingUsd = DEFAULT_DAILY_CEILING_USD;
      const usage = getDailyUsage(db, today);
      const spend = usage.cost_usd;
      const liveSessions = agents.reduce((sum, a) => sum + getLiveChildrenCount(db, a.id), 0);
      const unanswered = agents.reduce((sum, a) => {
        const row = db
          .prepare(
            `SELECT count(*) as cnt FROM escalations
             WHERE agent_id = ? AND answered_at IS NULL`,
          )
          .get(a.id) as { cnt: number };
        return sum + row.cnt;
      }, 0);
      out.write(
        `\nSpend today: $${spend.toFixed(4)} of $${dailyCeilingUsd.toFixed(2)} ceiling` +
          ` (${usage.pulses} pulse(s), ${usage.sessions} session(s))` +
          `  |  live sessions: ${liveSessions}` +
          `  |  unanswered escalations: ${unanswered}\n`,
      );

      // The 30-day numbers that say whether the loop works —
      // collector precision included (its all-time copy is gone).
      out.write(`\n${formatMetrics(computeMetrics(db))}`);
    }
  } finally {
    db.close();
  }
  return 0;
}

export function cmdMetrics(c: CliCtx): number {
  const { argv, out, err } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const raw = flagValue(argv, '--days');
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    err.write('lantern metrics: --days must be a whole number of days (1–3650)\n');
    return 1;
  }
  const db = openDb(dbPath);
  try {
    out.write(formatMetrics(computeMetrics(db, { days })));
  } finally {
    db.close();
  }
  return 0;
}

export function cmdSessions(c: CliCtx): number {
  const { argv, out } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const live = argv.includes('--live');
  const db = openDb(dbPath);
  try {
    const sessions = listSessions(db, { live });
    if (sessions.length === 0) {
      out.write(live ? 'no live sessions\n' : 'no sessions\n');
    } else {
      const label = live ? `${sessions.length} live session(s)` : `${sessions.length} session(s)`;
      out.write(`${label}:\n`);
      for (const s of sessions) {
        const age = formatAge(s.started_at);
        const ticket = s.ticket_id ? `  ticket=#${s.ticket_id}` : '';
        const cost = s.cost_usd > 0 ? `  $${s.cost_usd.toFixed(4)}` : '';
        out.write(
          `  ${s.id.slice(0, 8)}  [${s.status.padEnd(8)}]  ${s.tier.padEnd(12)}  age=${age}${ticket}${cost}  ${s.label ?? ''}\n`,
        );
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

export function cmdLogs(c: CliCtx): number {
  const { argv, out, err, lanternDir } = c;
  const rawId = argv[1];
  if (!rawId) {
    err.write('lantern logs: usage: lantern logs <pulse-id>\n');
    return 1;
  }
  const pulseId = Number(rawId);
  if (!Number.isInteger(pulseId) || pulseId <= 0) {
    err.write(`lantern logs: invalid pulse-id '${rawId}'\n`);
    return 1;
  }
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    const pulse = db.prepare('SELECT * FROM pulses WHERE id = ?').get(pulseId) as
      | {
          id: number;
          status: string;
          window_start: string;
          window_end: string;
          summary: string | null;
          cost_usd: number;
          duration_ms: number | null;
        }
      | undefined;
    if (!pulse) {
      err.write(`lantern logs: pulse #${pulseId} not found\n`);
      return 1;
    }
    out.write(
      `Pulse #${pulse.id}  [${pulse.status}]  ${pulse.window_start.slice(0, 16)} → ${pulse.window_end.slice(0, 16)}` +
        `  cost=$${pulse.cost_usd.toFixed(4)}` +
        (pulse.duration_ms ? `  ${Math.round(pulse.duration_ms / 1000)}s` : '') +
        '\n',
    );
    if (pulse.summary) {
      out.write(`\nSummary: ${pulse.summary}\n`);
    }
    // The forensic record, when this pulse's turn saved one.
    const orchTranscript = orchestratorTranscriptPath(lanternDir, pulse.id);
    if (existsSync(orchTranscript)) out.write(`Transcript: ${orchTranscript}\n`);

    const findings = getPulseFindings(db, pulseId);
    if (findings.length > 0) {
      out.write('\nFindings:\n');
      for (const f of findings) {
        const detail = f.detail ? `  ${f.detail.slice(0, 120)}` : '';
        const ticket = f.ticket_id ? `  → #${f.ticket_id}` : '';
        out.write(`  ${f.action_key.padEnd(20)}  [${f.outcome}]${ticket}${detail}\n`);
      }
    }

    const sessions = db
      .prepare('SELECT * FROM sessions WHERE pulse_id = ? ORDER BY started_at')
      .all(pulseId) as Session[];
    if (sessions.length > 0) {
      out.write('\nSessions:\n');
      for (const s of sessions) {
        const cost = s.cost_usd > 0 ? `  $${s.cost_usd.toFixed(4)}` : '';
        const ticket = s.ticket_id ? `  ticket=#${s.ticket_id}` : '';
        out.write(
          `  ${s.id.slice(0, 8)}  [${s.status.padEnd(8)}]  ${s.tier.padEnd(12)}${ticket}${cost}\n`,
        );
        if (s.result) {
          out.write(`    ${s.result.slice(0, 200)}\n`);
        }
        if (s.transcript_path && existsSync(s.transcript_path)) {
          out.write(`    Transcript: ${s.transcript_path}\n`);
        }
      }
    }
  } finally {
    db.close();
  }
  return 0;
}
