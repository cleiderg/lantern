import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EventContext } from '../types.ts';

export type McpTier = 'orchestrator' | 'read_only' | 'write_branch' | 'release';

const TIERS: readonly McpTier[] = ['orchestrator', 'read_only', 'write_branch', 'release'];

/** Unset or unrecognised means the least privilege, never the most. */
function parseTier(raw: string | undefined): McpTier {
  return TIERS.includes(raw as McpTier) ? (raw as McpTier) : 'read_only';
}

export type McpContext = {
  lanternDir: string;
  agentId: string | null;
  pulseId: number | null;
  sessionId: string | null;
  ticketId: number | null;
  tier: McpTier;
};

/** Read the session context injected by the daemon via environment variables. */
export function readContext(): McpContext {
  const raw = process.env;
  return {
    lanternDir: raw.LANTERN_DIR ?? join(homedir(), '.lantern'),
    agentId: raw.LANTERN_AGENT_ID ?? null,
    pulseId: raw.LANTERN_PULSE_ID ? Number(raw.LANTERN_PULSE_ID) : null,
    sessionId: raw.LANTERN_SESSION_ID ?? null,
    ticketId: raw.LANTERN_TICKET_ID ? Number(raw.LANTERN_TICKET_ID) : null,
    tier: parseTier(raw.LANTERN_TIER),
  };
}

/** Convert an McpContext to the EventContext expected by the store layer. */
export function toEventContext(ctx: McpContext): EventContext {
  return {
    actor: ctx.agentId ?? 'mcp',
    pulse_id: ctx.pulseId,
    session_id: ctx.sessionId,
  };
}
