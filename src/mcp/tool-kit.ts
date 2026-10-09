/**
 * The shape every Lantern MCP tool shares — its definition, its result, and the
 * two ways to return one.
 */

import type { Db } from '../db.ts';
import type { EventContext } from '../types.ts';
import type { McpContext } from './context.ts';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

export type InputSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  /** Which session tiers may call this tool. */
  tier: 'all' | 'orchestrator';
  handler: (
    db: Db,
    ctx: McpContext,
    eventCtx: EventContext,
    args: Record<string, unknown>,
  ) => ToolResult;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
