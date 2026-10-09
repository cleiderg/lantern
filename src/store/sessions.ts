import type { Db } from '../db.ts';
import type { Session, SessionStatus, SessionTierName } from '../types.ts';
import { LIVE_SQL } from '../types.ts';

export type CreateSessionInput = {
  id: string;
  agentId: string;
  pulseId?: number | null;
  ticketId?: number | null;
  label?: string | null;
  tier: SessionTierName;
  pid?: number | null;
};

export type UpdateSessionInput = {
  status?: SessionStatus;
  costUsd?: number;
  numTurns?: number | null;
  result?: string | null;
  exitCode?: number | null;
  worktree?: string | null;
  branch?: string | null;
  pid?: number | null;
  endedAt?: string | null;
  transcriptPath?: string | null;
};

export function createSession(db: Db, input: CreateSessionInput): string {
  db.prepare(
    `INSERT INTO sessions (id, agent_id, pulse_id, ticket_id, label, tier, pid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.agentId,
    input.pulseId ?? null,
    input.ticketId ?? null,
    input.label ?? null,
    input.tier,
    input.pid ?? null,
  );
  return input.id;
}

export function getSession(db: Db, id: string): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function listSessions(
  db: Db,
  opts: { live?: boolean; agentId?: string; limit?: number; offset?: number } = {},
): Session[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.live) {
    conditions.push(`status IN ${LIVE_SQL}`);
  }
  if (opts.agentId) {
    conditions.push('agent_id = ?');
    params.push(opts.agentId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 200, opts.offset ?? 0) as Session[];
}

export function updateSession(db: Db, id: string, input: UpdateSessionInput): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.costUsd !== undefined) {
    sets.push('cost_usd = ?');
    params.push(input.costUsd);
  }
  if (input.numTurns !== undefined) {
    sets.push('num_turns = ?');
    params.push(input.numTurns);
  }
  if (input.result !== undefined) {
    sets.push('result = ?');
    params.push(input.result);
  }
  if (input.exitCode !== undefined) {
    sets.push('exit_code = ?');
    params.push(input.exitCode);
  }
  if (input.worktree !== undefined) {
    sets.push('worktree = ?');
    params.push(input.worktree);
  }
  if (input.transcriptPath !== undefined) {
    sets.push('transcript_path = ?');
    params.push(input.transcriptPath);
  }
  if (input.branch !== undefined) {
    sets.push('branch = ?');
    params.push(input.branch);
  }
  if (input.pid !== undefined) {
    sets.push('pid = ?');
    params.push(input.pid);
  }
  if (input.endedAt !== undefined) {
    sets.push('ended_at = ?');
    params.push(input.endedAt);
  }

  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getLiveSessions(db: Db, agentId: string): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE agent_id = ? AND status IN ${LIVE_SQL}
       ORDER BY started_at ASC`,
    )
    .all(agentId) as Session[];
}
