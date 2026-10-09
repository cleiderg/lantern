/**
 * Lantern's MCP tool registry: the ticket tools every tier may call
 * (ticket-tools.ts) and the orchestrator-only ones (orchestrator-tools.ts),
 * listed and dispatched by tier.
 */

import type { Db } from '../db.ts';
import type { EventContext } from '../types.ts';
import type { McpContext, McpTier } from './context.ts';
import { ORCHESTRATOR_TOOLS } from './orchestrator-tools.ts';
import { TICKET_TOOLS } from './ticket-tools.ts';
import type { InputSchema, ToolDef, ToolResult } from './tool-kit.ts';

export type { ToolResult };

const TOOL_DEFS: ToolDef[] = [...TICKET_TOOLS, ...ORCHESTRATOR_TOOLS];

// ── Exports ───────────────────────────────────────────────────────────────────

/** Tool list returned by tools/list, filtered to those accessible from `tier`. */
export function getTools(
  tier: McpTier,
): Array<{ name: string; description: string; inputSchema: InputSchema }> {
  return TOOL_DEFS.filter((t) => t.tier === 'all' || tier === 'orchestrator').map(
    ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
  );
}

/** All tool names, regardless of tier — used in tests. */
export const ALL_TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Dispatch a tools/call request. */
export function callTool(
  db: Db,
  ctx: McpContext,
  eventCtx: EventContext,
  name: string,
  args: Record<string, unknown>,
): ToolResult {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  if (def.tier === 'orchestrator' && ctx.tier !== 'orchestrator') {
    return {
      content: [
        {
          type: 'text',
          text: `Tool '${name}' requires orchestrator tier. This session is '${ctx.tier}'.`,
        },
      ],
      isError: true,
    };
  }

  return def.handler(db, ctx, eventCtx, args);
}
