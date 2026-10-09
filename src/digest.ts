import type Database from 'better-sqlite3';
import { type AgentConfig, bodySection } from './agent-config.ts';
import { DEFAULT_DAILY_CEILING_USD } from './budget.ts';
import type { PulseWindow } from './scheduler.ts';
import { getDailySpend, utcDay } from './store/usage.ts';
import { formatAge } from './time.ts';
import type { Agent } from './types.ts';
import { LIVE_SQL, TERMINAL_SQL } from './types.ts';
import { oneLine, untrustedBlock } from './untrusted.ts';

type OpenTicketRow = {
  id: number;
  title: string;
  status: string;
  priority: string;
  created_at: string;
};

type SessionRow = {
  id: string;
  label: string | null;
  ticket_id: number | null;
  tier: string;
  status: string;
  started_at: string;
};

type PulseRow = {
  started_at: string;
  status: string;
  summary: string | null;
};

type EscalationRow = {
  id: number;
  severity: string;
  question: string;
  created_at: string;
  ticket_id: number | null;
};

/** `created_at` is SQLite's zoneless UTC; `new Date()` read it as local time. */
const age = (ts: string, now: Date) => formatAge(ts, now.getTime());

/** Builds the pulse digest string from SQL state alone — correct on a cold start. */
export function buildDigest(
  db: Database.Database,
  agent: Agent,
  window: PulseWindow,
  dailyCeilingUsd = DEFAULT_DAILY_CEILING_USD,
  now: Date = new Date(),
  /** The agent's parsed .agent.md; null/absent for a pre-config row. */
  config: AgentConfig | null = null,
): string {
  const todayStr = utcDay(now);

  const openCount = (
    db
      .prepare(
        `SELECT count(*) as n FROM tickets
         WHERE status NOT IN ${TERMINAL_SQL} AND (agent_id = ? OR agent_id IS NULL)`,
      )
      .get(agent.id) as { n: number }
  ).n;

  const openTickets = db
    .prepare(
      `SELECT id, title, status, priority, created_at FROM tickets
       WHERE status NOT IN ${TERMINAL_SQL}
         AND (agent_id = ? OR agent_id IS NULL)
       ORDER BY CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
                created_at ASC
       LIMIT 40`,
    )
    // Scoped to this agent (plus unowned, human-filed tickets): with two
    // agents side by side, each must not see the other's workload as its own.
    .all(agent.id) as OpenTicketRow[];

  const liveSessions = db
    .prepare(
      `SELECT id, label, ticket_id, tier, status, started_at FROM sessions
       WHERE agent_id = ? AND status IN ${LIVE_SQL}
       ORDER BY started_at ASC`,
    )
    .all(agent.id) as SessionRow[];

  const lastPulses = db
    .prepare(
      `SELECT started_at, status, summary FROM pulses
       WHERE agent_id = ? AND status NOT IN ('running','skipped')
       ORDER BY started_at DESC LIMIT 5`,
    )
    .all(agent.id) as PulseRow[];

  const unanswered = db
    .prepare(
      `SELECT id, severity, question, created_at, ticket_id FROM escalations
       WHERE agent_id = ? AND answered_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(agent.id) as EscalationRow[];

  const spent = getDailySpend(db, todayStr);
  const budgetRemaining = Math.max(0, dailyCeilingUsd - spent);

  // Law 8: ticket titles, past summaries and escalation questions can all carry
  // collected text, so their rows go inside untrusted frames.
  const lines: string[] = [];

  lines.push(`# Pulse Digest — ${agent.display_name}`);
  lines.push('');
  lines.push(
    `**Window:** ${window.window_start.slice(0, 19)}Z → ${window.window_end.slice(0, 19)}Z`,
  );
  lines.push(
    `**Budget remaining today:** $${budgetRemaining.toFixed(2)} of $${dailyCeilingUsd.toFixed(2)}`,
  );
  lines.push('');

  lines.push('## Mission');
  lines.push(agent.mission);
  lines.push('');

  // Mission, expertise and laws from the agent config. The config is
  // operator-written and version-controlled — trusted, unlike collected text.
  for (const heading of ['Expertise', 'Laws']) {
    const text = config && bodySection(config.body, heading);
    if (text) lines.push(`## ${heading}`, '', text, '');
  }

  lines.push('## Every-pulse Actions');
  if (config?.actions.length) {
    config.actions.forEach((a, i) => {
      lines.push(`${i + 1}. \`${a.key}\` — playbook ${a.playbook}`);
    });
    const how = bodySection(config.body, 'Every-pulse actions');
    if (how) lines.push('', how);
  } else {
    lines.push('1. `heartbeat.selfcheck` — verify the daemon is healthy');
  }
  lines.push(
    '',
    'Record a finding under these keys, or `staffing` for a staffing decision; other keys are refused.',
  );
  lines.push('');

  const ticketLabel =
    openCount > openTickets.length
      ? `## Open Tickets (${openTickets.length} of ${openCount}, oldest p0-first)`
      : `## Open Tickets (${openTickets.length})`;
  lines.push(ticketLabel);

  if (openTickets.length === 0) {
    lines.push('_No open tickets._');
  } else {
    const rows = [
      '| ID | Title | Status | Priority | Age |',
      '|----|-------|--------|----------|-----|',
    ];
    for (const t of openTickets) {
      rows.push(
        `| #${t.id} | ${oneLine(t.title, 60)} | ${t.status} | ${t.priority} | ${age(t.created_at, now)} |`,
      );
    }
    lines.push(untrustedBlock('ticket titles', rows.join('\n')));
  }
  lines.push('');

  lines.push(`## Live Sessions (${liveSessions.length})`);
  if (liveSessions.length === 0) {
    lines.push('_No live sessions._');
  } else {
    for (const s of liveSessions) {
      const label = s.label ?? s.id.slice(0, 8);
      const ticket = s.ticket_id ? ` ticket #${s.ticket_id}` : '';
      lines.push(`- ${label}${ticket} — ${s.tier} — ${s.status} (${age(s.started_at, now)})`);
    }
  }
  lines.push('');

  lines.push('## Last 5 Pulse Summaries');
  if (lastPulses.length === 0) {
    lines.push('_No prior pulses._');
  } else {
    const rows = lastPulses.map(
      (p) =>
        `- [${p.started_at.slice(0, 19)}Z] ${p.status} — ${oneLine(p.summary ?? '(no summary)')}`,
    );
    lines.push(untrustedBlock('past pulse summaries', rows.join('\n')));
  }
  lines.push('');

  lines.push(`## Unanswered Escalations (${unanswered.length})`);
  if (unanswered.length === 0) {
    lines.push('_None._');
  } else {
    const rows = unanswered.map((e) => {
      const ticket = e.ticket_id ? ` (ticket #${e.ticket_id})` : '';
      return `- [${e.severity.toUpperCase()}] ${oneLine(e.question)}${ticket} — ${age(e.created_at, now)} ago`;
    });
    lines.push(untrustedBlock('escalation questions', rows.join('\n')));
  }
  lines.push('');

  return lines.join('\n');
}
