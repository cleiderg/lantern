import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Env vars injected by the daemon into the MCP server process. */
export type McpEnv = {
  LANTERN_DIR: string;
  LANTERN_AGENT_ID?: string;
  LANTERN_PULSE_ID?: string;
  LANTERN_SESSION_ID?: string;
  LANTERN_TIER?: string;
  LANTERN_TICKET_ID?: string;
};

/** Absolute path to server.ts, resolved relative to this module. */
function serverPath(): string {
  return fileURLToPath(new URL('server.ts', import.meta.url));
}

/** Generate the mcp.json content for a given Lantern directory and env. */
export function mcpConfigJson(lanternDir: string, env?: McpEnv): string {
  // No env = the human attach config. The server fails closed to read_only,
  // so a human session must name its tier.
  const effectiveEnv: McpEnv = env ?? { LANTERN_DIR: lanternDir, LANTERN_TIER: 'orchestrator' };
  return JSON.stringify(
    {
      mcpServers: {
        lantern: {
          command: process.execPath, // exact node binary in use — no PATH ambiguity
          args: [serverPath()],
          env: effectiveEnv,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Write ~/.lantern/mcp.json and return its path.
 * Called by `lantern init` — this file is the human "attach with" config only.
 * Daemon spawns use writeSessionMcpConfig() below, which injects per-invocation env.
 */
export function writeMcpConfig(lanternDir: string, env?: McpEnv): string {
  const configPath = join(lanternDir, 'mcp.json');
  writeFileSync(configPath, mcpConfigJson(lanternDir, env));
  return configPath;
}

/**
 * Write a per-invocation MCP config to ~/.lantern/mcp/<name>.json and return its path.
 * Concurrent pulses and sessions each get their own file so they don't race on a shared path.
 *
 * @param name - unique name for this invocation, e.g. "pulse-42" or "session-<uuid>"
 * @param env  - env vars to inject (must include at minimum LANTERN_DIR, LANTERN_AGENT_ID, LANTERN_PULSE_ID)
 */
export function writeSessionMcpConfig(lanternDir: string, name: string, env: McpEnv): string {
  const dir = join(lanternDir, 'mcp');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `${name}.json`);
  writeFileSync(configPath, mcpConfigJson(lanternDir, env));
  return configPath;
}
