#!/usr/bin/env node

/**
 * Lantern MCP server — stdio transport, no external SDK.
 *
 * Attach to a claude session via --mcp-config ~/.lantern/mcp.json.
 * The daemon generates that config with per-pulse env vars injected:
 *
 *   LANTERN_DIR        path to ~/.lantern          (default: ~/.lantern)
 *   LANTERN_AGENT_ID   orchestrator agent id
 *   LANTERN_PULSE_ID   current pulse (integer)  — omit for manual sessions
 *   LANTERN_SESSION_ID harness session id        — omit for manual sessions
 *   LANTERN_TIER       orchestrator | read_only | write_branch | release
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdout/stdin.
 * Methods handled: initialize, notifications/initialized, ping, tools/list, tools/call.
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { readContext, toEventContext } from './context.ts';
import { callTool, getTools } from './tools.ts';

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

type RpcId = number | string | null;

function send(obj: object): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function ok(id: RpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function rpcError(id: RpcId, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── startup ───────────────────────────────────────────────────────────────────

const ctx = readContext();
initLantern(ctx.lanternDir);
const db = openDb(join(ctx.lanternDir, 'lantern.db'));
const eventCtx = toEventContext(ctx);
const tools = getTools(ctx.tier);

// ── request dispatch ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown };
  try {
    msg = JSON.parse(trimmed) as typeof msg;
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }

  const id = msg.id ?? null;
  const isNotification = !Object.hasOwn(msg, 'id');

  switch (msg.method) {
    case 'initialize': {
      const params = msg.params as { protocolVersion?: string } | undefined;
      ok(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lantern', version: '0.0.0' },
      });
      break;
    }

    case 'notifications/initialized':
      // Notification — no response.
      break;

    case 'ping':
      ok(id, {});
      break;

    case 'tools/list':
      ok(id, { tools });
      break;

    case 'tools/call': {
      const params = msg.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      if (!params?.name) {
        rpcError(id, -32602, 'Missing tool name');
        break;
      }
      try {
        const result = callTool(db, ctx, eventCtx, params.name, params.arguments ?? {});
        ok(id, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ok(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
      break;
    }

    default:
      if (!isNotification) {
        rpcError(id, -32601, `Method not found: ${msg.method ?? '(none)'}`);
      }
  }
});

rl.on('close', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
