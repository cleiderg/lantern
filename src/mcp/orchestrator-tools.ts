/**
 * The orchestrator-only tools (5): observation_record, pulse_finding,
 * staff_ticket, playbook_run, log_query.
 */

import { randomUUID } from 'node:crypto';
import { getAgent } from '../agent.ts';
import { runtimeSettings } from '../agent-config.ts';
import { FileLogSource } from '../collectors/logs-scan.ts';
import type { Db } from '../db.ts';
import { runHeartbeatSelfcheck } from '../selfcheck.ts';
import { recordObservation } from '../store/observations.ts';
import { getTicket } from '../store/tickets.ts';
import { staffRefusal } from '../ticket-policy.ts';
import { fail, ok, type ToolDef } from './tool-kit.ts';

const handleObservationRecord: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  const result = recordObservation(db, {
    fingerprint: args.fingerprint as string,
    source: args.source as string,
    sample: args.sample as string,
    severity: args.severity as string | undefined,
    pulseId: ctx.pulseId,
  });
  return ok(JSON.stringify(result));
};

const handlePulseFinding: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  if (!ctx.pulseId) return fail('pulse_finding requires LANTERN_PULSE_ID to be set');
  const outcome = args.outcome as string;
  const detail = args.detail as string | undefined;
  const ticketId = args.ticket_id as number | undefined;
  // free-form keys split one action across several names in the
  // metrics (`staffing`, `staff.work`, `staff.ticket`).
  const allowed = allowedActionKeys(db, ctx.agentId);
  const actionKey = canonicalActionKey(args.action_key as string, allowed);
  if (actionKey === null) {
    return fail(
      `Unknown action_key '${String(args.action_key)}'. Record one of: ${[...allowed].join(', ')}.`,
    );
  }
  // One row per every-pulse action. Playbooks and the collect phase
  // record their own; the model restating them doubled every action.
  // Not an error, so the model does not retry.
  const existing = db
    .prepare('SELECT outcome FROM pulse_findings WHERE pulse_id = ? AND action_key = ? LIMIT 1')
    .get(ctx.pulseId, actionKey) as { outcome: string } | undefined;
  if (existing) {
    return ok(
      `Finding already recorded for ${actionKey} this pulse (${existing.outcome}); no second row written.`,
    );
  }
  try {
    db.prepare(
      'INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail, ticket_id) VALUES (?, ?, ?, ?, ?)',
    ).run(ctx.pulseId, actionKey, outcome, detail ?? null, ticketId ?? null);
    return ok(`Finding recorded: ${actionKey} → ${outcome}`);
  } catch (ex) {
    return fail(ex instanceof Error ? ex.message : String(ex));
  }
};

/** Keys every agent may record: the daemon's collectors, the self-check, and a staffing decision. */
export const BUILTIN_ACTION_KEYS = [
  'logs.scan',
  'inbox.bugs',
  'ci.watch',
  'heartbeat.selfcheck',
  'staffing',
] as const;

/** The agent's `actions:` keys first (its every-pulse list), then the built-ins. */
function allowedActionKeys(db: Db, agentId: string | null): Set<string> {
  const agent = agentId ? getAgent(db, agentId) : null;
  let configured: string[] = [];
  try {
    configured = agent ? (runtimeSettings(agent).config?.actions.map((a) => a.key) ?? []) : [];
  } catch {
    // A broken config is reported by the pulse gates; built-ins still apply.
  }
  return new Set([...configured, ...BUILTIN_ACTION_KEYS]);
}

/** The key as recorded, or null if it is not one of `allowed`. `staff*` → `staffing`. */
export function canonicalActionKey(key: string, allowed: Set<string>): string | null {
  const k = String(key ?? '')
    .trim()
    .toLowerCase();
  if (allowed.has(k)) return k;
  if (/^staff(ing)?([._-].*)?$/.test(k) || k === 'staff_ticket') return 'staffing';
  return null;
}

const handleStaffTicket: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  const ticketId = args.ticket_id as number;
  const tier = args.tier as string;
  const label = args.label as string | undefined;

  // A session with no agent is never selected by that agent's reap — it would
  // sit queued forever.
  if (!ctx.agentId) return fail('staff_ticket requires LANTERN_AGENT_ID (daemon must inject it)');
  const ticket = getTicket(db, ticketId);
  if (!ticket) return fail(`Ticket #${ticketId} not found`);
  // Policy: ownership, triage, terminal, live session, blocking
  // escalation, release approval.
  const refusal = staffRefusal(db, ticket, ctx.agentId, tier);
  if (refusal) return fail(refusal);

  const sessionId = randomUUID();
  try {
    db.prepare(
      'INSERT INTO sessions (id, agent_id, pulse_id, ticket_id, label, tier) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, ctx.agentId, ctx.pulseId, ticketId, label ?? null, tier);
    return ok(JSON.stringify({ session_id: sessionId, status: 'queued' }));
  } catch (ex) {
    return fail(ex instanceof Error ? ex.message : String(ex));
  }
};

const handlePlaybookRun: ToolDef['handler'] = (db, ctx, _eventCtx, args) => {
  const key = args.key as string;

  if (key === 'heartbeat.selfcheck') {
    if (ctx.pulseId === null) {
      return fail("playbook_run('heartbeat.selfcheck') requires LANTERN_PULSE_ID");
    }
    const pulseExists = db.prepare('SELECT 1 FROM pulses WHERE id = ?').get(ctx.pulseId);
    if (!pulseExists) return fail(`Pulse ${ctx.pulseId} not found`);
    return ok(JSON.stringify(runHeartbeatSelfcheck(db, ctx.pulseId)));
  }

  if (key === 'logs.scan' || key === 'inbox.bugs') {
    if (!ctx.agentId || ctx.pulseId === null) {
      return fail(`playbook_run('${key}') requires LANTERN_AGENT_ID and LANTERN_PULSE_ID`);
    }
    // Decision 11: collectors run in the daemon's collect phase, before every
    // turn. This key hands back what that scan recorded; it never scans
    // again — a rescan double-counted occurrences.
    const prior = db
      .prepare(
        `SELECT outcome, detail, ticket_id FROM pulse_findings
         WHERE pulse_id = ? AND action_key = ? ORDER BY id`,
      )
      .all(ctx.pulseId, key);
    if (prior.length > 0) {
      return ok(JSON.stringify({ alreadyRan: true, key, findings: prior }));
    }
    const where =
      key === 'logs.scan'
        ? 'agent config log_sources, or LANTERN_LOG_SOURCE'
        : 'agent config inbox_source, or LANTERN_INBOX_SOURCE';
    return ok(
      JSON.stringify({
        supported: false,
        reason: `no ${key} ran this pulse: the collect phase scans every configured source (${where}) before the turn — none is configured, or the collect phase failed (see the digest)`,
      }),
    );
  }

  return ok(JSON.stringify({ supported: false, reason: `unknown playbook key: '${key}'` }));
};

const handleLogQuery: ToolDef['handler'] = (_db, _ctx, _eventCtx, args) => {
  const source = args.source as string;
  const since = (args.since as string | undefined) ?? new Date(Date.now() - 3600_000).toISOString();
  const until = (args.until as string | undefined) ?? new Date().toISOString();
  const limit = (args.limit as number | undefined) ?? 200;

  // File-based source (used in dev/test and for fixture replay).
  // A source beginning with 'file://' is treated as a path to ndjson output.
  const filePath = source.startsWith('file://') ? source.slice(7) : source;
  const logSource = new FileLogSource(filePath);
  const result = logSource.query({ start: since, end: until });

  if (result.kind === 'no_data') {
    return ok(
      JSON.stringify({
        kind: 'no_data',
        message:
          'Log data not available for the requested window (file not found or retention expired)',
      }),
    );
  }

  const entries = result.entries.slice(0, limit);
  return ok(JSON.stringify({ kind: 'entries', count: entries.length, entries }));
};

export const ORCHESTRATOR_TOOLS: ToolDef[] = [
  {
    name: 'observation_record',
    description:
      'Upsert a fingerprint into observations. Returns whether it clears the ticketing threshold.',
    inputSchema: {
      type: 'object',
      required: ['fingerprint', 'source', 'sample'],
      properties: {
        fingerprint: { type: 'string', description: 'sha1(source+normalized_message+location)' },
        source: { type: 'string', enum: ['logs', 'email', 'ci'] },
        sample: { type: 'string', description: 'Representative raw text for human reading' },
        severity: { type: 'string', enum: ['fault', 'crash', 'warning', 'info'] },
      },
    },
    tier: 'orchestrator',
    handler: handleObservationRecord,
  },

  {
    name: 'pulse_finding',
    description:
      "Record one every-pulse action's outcome. 'clean' is mandatory — a loop that only records problems is indistinguishable from a broken loop.",
    inputSchema: {
      type: 'object',
      required: ['action_key', 'outcome'],
      properties: {
        action_key: {
          type: 'string',
          description:
            "One of the agent's every-pulse action keys (listed in the digest), or 'staffing' for a staffing decision. Other keys are refused.",
        },
        outcome: { type: 'string', enum: ['clean', 'finding', 'skipped', 'error'] },
        detail: { type: 'string' },
        ticket_id: { type: 'number' },
      },
    },
    tier: 'orchestrator',
    handler: handlePulseFinding,
  },

  {
    name: 'staff_ticket',
    description:
      'Request a child session for a ticket at a given capability tier. Queued, not executed inline. Returns queued or started.',
    inputSchema: {
      type: 'object',
      required: ['ticket_id', 'tier'],
      properties: {
        ticket_id: { type: 'number' },
        tier: { type: 'string', enum: ['read_only', 'write_branch', 'release'] },
        label: { type: 'string', description: 'Human-readable session label, e.g. 729-fix-auth' },
      },
    },
    tier: 'orchestrator',
    handler: handleStaffTicket,
  },

  {
    name: 'playbook_run',
    description:
      "Invoke a playbook by key. 'heartbeat.selfcheck' runs now; 'logs.scan' and 'inbox.bugs' already ran in this pulse's collect phase and return what it found.",
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: "Playbook key, e.g. 'inbox.bugs', 'logs.scan'" },
      },
    },
    tier: 'orchestrator',
    handler: handlePlaybookRun,
  },

  {
    name: 'log_query',
    description:
      'Query the host log source (macOS log show / journalctl / file) over a time window.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source: { type: 'string', description: 'Log source identifier from agent config' },
        since: { type: 'string', description: 'ISO 8601 start time' },
        until: { type: 'string', description: 'ISO 8601 end time' },
        predicate: {
          type: 'string',
          description: 'Filter expression (syntax depends on source adapter)',
        },
        limit: { type: 'number' },
      },
    },
    tier: 'orchestrator',
    handler: handleLogQuery,
  },
];
