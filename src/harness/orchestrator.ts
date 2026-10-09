import type Database from 'better-sqlite3';
import type { AgentConfig } from '../agent-config.ts';
import { PER_SESSION_CEILING_USD } from '../budget.ts';
import { writeSessionMcpConfig } from '../mcp/config.ts';
import { ensurePersonaFile } from '../persona.ts';
import { finishPulse, writePulseFinding } from '../store/pulses.ts';
import { orchestratorTranscriptPath } from '../transcripts.ts';
import type { Agent } from '../types.ts';
import { tierFlags } from './tiers.ts';
import type { HarnessAdapter } from './types.ts';

export type OrchestratorOpts = {
  db: Database.Database;
  agent: Agent;
  pulseId: number;
  digest: string;
  lanternDir: string;
  harness: HarnessAdapter;
  maxTurns?: number;
  timeoutMs?: number;
  costCeilingUsd?: number;
  /** The agent's parsed .agent.md, for the persona. */
  config?: AgentConfig | null;
  /** The agent's daily budget — the ceiling Law 7 trips against when the pulse closes. */
  dailyCeilingUsd?: number;
};

export type OrchestratorResult = {
  status: 'clean' | 'acted' | 'escalated' | 'error' | 'skipped';
  summary: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
};

/**
 * Runs the orchestrator turn for one pulse.
 * Spawns via the injected HarnessAdapter, polls for completion,
 * enforces the cost ceiling, and closes the pulse row.
 */
export async function runOrchestratorTurn(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const {
    db,
    agent,
    pulseId,
    digest,
    lanternDir,
    harness,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
    costCeilingUsd = PER_SESSION_CEILING_USD,
    dailyCeilingUsd,
    config = null,
  } = opts;

  const mcpConfig = writeSessionMcpConfig(lanternDir, `pulse-${pulseId}`, {
    LANTERN_DIR: lanternDir,
    LANTERN_AGENT_ID: agent.id,
    LANTERN_PULSE_ID: String(pulseId),
    LANTERN_TIER: 'orchestrator',
  });
  const startedAt = Date.now();

  const flags = tierFlags('read_only');
  const systemPromptFile = ensurePersonaFile(lanternDir, agent, config);
  let handle: { id: string };
  try {
    handle = await harness.run({
      prompt: digest,
      cwd: agent.workdir,
      tier: 'read_only',
      tools: flags.tools,
      transcriptPath: orchestratorTranscriptPath(lanternDir, pulseId),
      allowedTools: flags.allowedTools,
      disallowedTools: flags.disallowedTools,
      mcpConfig,
      systemPromptFile,
      maxTurns,
      timeoutMs,
      costCeilingUsd,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const durationMs = Date.now() - startedAt;
    finishPulse(db, pulseId, {
      dailyCeilingUsd,
      status: 'error',
      error,
      durationMs,
    });
    writePulseFinding(db, {
      pulseId,
      actionKey: 'heartbeat.selfcheck',
      outcome: 'error',
      detail: error,
    });
    return { status: 'error', summary: error, costUsd: 0, durationMs, sessionId: '' };
  }

  const state = await harness.poll(handle.id);
  const durationMs = Date.now() - startedAt;

  if (state.isError || state.status === 'failed') {
    const error = `harness session failed: ${state.result}`;
    finishPulse(db, pulseId, {
      dailyCeilingUsd,
      status: 'error',
      error,
      costUsd: state.costUsd,
      durationMs,
      sessionId: state.sessionId,
    });
    writePulseFinding(db, {
      pulseId,
      actionKey: 'heartbeat.selfcheck',
      outcome: 'error',
      detail: error,
    });
    return {
      status: 'error',
      summary: error,
      costUsd: state.costUsd,
      durationMs,
      sessionId: state.sessionId,
    };
  }

  if (state.costUsd >= costCeilingUsd) {
    const error = `cost ceiling exceeded: $${state.costUsd.toFixed(4)} >= $${costCeilingUsd}`;
    finishPulse(db, pulseId, {
      dailyCeilingUsd,
      status: 'error',
      error,
      costUsd: state.costUsd,
      durationMs,
      sessionId: state.sessionId,
    });
    writePulseFinding(db, {
      pulseId,
      actionKey: 'heartbeat.selfcheck',
      outcome: 'error',
      detail: error,
    });
    return {
      status: 'error',
      summary: error,
      costUsd: state.costUsd,
      durationMs,
      sessionId: state.sessionId,
    };
  }

  // Derive status from DB side effects written by the turn via MCP tools.
  // Text is only used for the summary — never as a control path.
  const resultText = state.result;
  const summary = resultText.split('\n')[0]?.slice(0, 500) ?? resultText.slice(0, 500);

  const escalationCount = (
    db.prepare(`SELECT count(*) as cnt FROM escalations WHERE pulse_id = ?`).get(pulseId) as {
      cnt: number;
    }
  ).cnt;
  const sessionCount = (
    db.prepare(`SELECT count(*) as cnt FROM sessions WHERE pulse_id = ?`).get(pulseId) as {
      cnt: number;
    }
  ).cnt;
  const eventCount = (
    db.prepare(`SELECT count(*) as cnt FROM ticket_events WHERE pulse_id = ?`).get(pulseId) as {
      cnt: number;
    }
  ).cnt;

  // If the orchestrator wrote its own findings via the pulse_finding MCP tool, don't
  // fabricate a daemon-written duplicate. If it wrote none, record `skipped` — an
  // unverified action is never `clean`.
  //
  // This runs BEFORE the status is derived: the pulse's own status depends on
  // whether its actions achieved any coverage, so the findings must be settled
  // first.
  const ownFindings = db
    .prepare(`SELECT count(*) as cnt FROM pulse_findings WHERE pulse_id = ?`)
    .get(pulseId) as { cnt: number };
  if (ownFindings.cnt === 0) {
    writePulseFinding(db, {
      pulseId,
      actionKey: 'heartbeat.selfcheck',
      outcome: 'skipped',
      detail: 'orchestrator recorded no finding via pulse_finding tool',
    });
  }

  // Did any action actually observe something? `clean` and `finding` mean the
  // check ran; `skipped` and `error` mean it did not.
  const verifiedCount = (
    db
      .prepare(
        `SELECT count(*) as cnt FROM pulse_findings
         WHERE pulse_id = ? AND outcome IN ('clean', 'finding')`,
      )
      .get(pulseId) as { cnt: number }
  ).cnt;

  /*
   * Precedence: escalated > acted > skipped > clean.
   *
   * The last step is the skipped-not-clean rule applied one level up from findings: a pulse
   * whose every action was skipped has verified nothing, so calling it `clean`
   * makes the ledger claim coverage it does not have — the same lie as a log
   * scan reporting clean over a window with no retained data. `lantern status`
   * used to print `[clean]` beside `heartbeat.selfcheck:skipped` on the same
   * row and contradict itself.
   *
   * A pulse that escalated or acted keeps that status even with no verified
   * coverage: those are the signals a human needs to see first, and the
   * findings still record what was and wasn't checked.
   */
  const status: OrchestratorResult['status'] =
    escalationCount > 0
      ? 'escalated'
      : sessionCount > 0 || eventCount > 0
        ? 'acted'
        : verifiedCount > 0
          ? 'clean'
          : 'skipped';

  finishPulse(db, pulseId, {
    dailyCeilingUsd,
    status,
    summary,
    costUsd: state.costUsd,
    durationMs,
    sessionId: state.sessionId,
  });

  return { status, summary, costUsd: state.costUsd, durationMs, sessionId: state.sessionId };
}
