import type Database from 'better-sqlite3';
import type { AgentConfig } from './agent-config.ts';
import type { Agent, AgentState } from './types.ts';

export function getAgent(db: Database.Database, id: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function listAgents(db: Database.Database): Agent[] {
  return db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Agent[];
}

/**
 * Returns the first-registered agent, or creates a minimal default 'lantern'
 * agent. Ordered explicitly: `LIMIT 1` alone let SQLite pick.
 */
export function ensureDefaultAgent(db: Database.Database, workdir: string): Agent {
  const existing = db.prepare('SELECT * FROM agents ORDER BY created_at, rowid LIMIT 1').get() as
    | Agent
    | undefined;
  if (existing) return existing;

  db.prepare(
    `INSERT INTO agents (id, display_name, config_path, mission, workdir)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'lantern',
    'Lantern',
    'agents/lantern.agent.md',
    'Watch the system and file tickets for anything worth human attention.',
    workdir,
  );
  return db.prepare('SELECT * FROM agents WHERE id = ?').get('lantern') as Agent;
}

export function setAgentState(
  db: Database.Database,
  id: string,
  state: AgentState,
  pausedReason: string | null = null,
): void {
  db.prepare(
    `UPDATE agents SET state = ?, paused_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(state, pausedReason, id);
}

export function setAgentLastPulse(db: Database.Database, id: string, lastPulseAt: string): void {
  db.prepare(`UPDATE agents SET last_pulse_at = ?, updated_at = datetime('now') WHERE id = ?`).run(
    lastPulseAt,
    id,
  );
}

export function setAgentNextPulse(db: Database.Database, id: string, nextPulseAt: string): void {
  db.prepare(`UPDATE agents SET next_pulse_at = ?, updated_at = datetime('now') WHERE id = ?`).run(
    nextPulseAt,
    id,
  );
}

/**
 * Create or refresh an agent row from its parsed `.agent.md`.
 * `configPath` is stored absolute so the daemon can re-read it every tick.
 * `state` is left alone: registering or editing a config never starts,
 * resumes or untrips an agent.
 */
export function upsertAgentFromConfig(
  db: Database.Database,
  cfg: AgentConfig,
  configPath: string,
): Agent {
  db.prepare(
    `INSERT INTO agents (id, display_name, config_path, mission, heartbeat_seconds, max_children, workdir)
     VALUES (@id, @displayName, @configPath, @mission, @heartbeatSeconds, @maxChildren, @workdir)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       config_path = excluded.config_path,
       mission = excluded.mission,
       heartbeat_seconds = excluded.heartbeat_seconds,
       max_children = excluded.max_children,
       workdir = excluded.workdir,
       updated_at = datetime('now')`,
  ).run({
    id: cfg.id,
    displayName: cfg.displayName,
    configPath,
    mission: cfg.mission,
    heartbeatSeconds: cfg.heartbeatSeconds,
    maxChildren: cfg.maxChildren,
    workdir: cfg.workdir,
  });
  return getAgent(db, cfg.id) as Agent;
}

/**
 * Move an agent from `from` to `to` only if it is still in `from`. Returns
 * whether it moved. The daemon's shutdown uses it so SIGTERM never overwrites
 * a state someone else chose (`lantern stop`'s paused, a Law 7 trip).
 */
export function transitionAgentState(
  db: Database.Database,
  id: string,
  from: AgentState,
  to: AgentState,
): boolean {
  return (
    db
      .prepare(
        `UPDATE agents SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?`,
      )
      .run(to, id, from).changes === 1
  );
}
