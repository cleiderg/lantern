/** One interface, swap the impl without touching the rest of the system. */

export type SessionTier = 'read_only' | 'write_branch' | 'release';

export type SessionSpec = {
  prompt: string;
  systemPromptFile?: string;
  cwd: string;
  /** Where to write the raw stream-json, whole and untruncated. */
  transcriptPath?: string;
  /** Extra environment for the session process, merged over the daemon's. */
  env?: Record<string, string>;
  tier: SessionTier;
  /** Built-in tools that exist in the session (`--tools`); absent = none. */
  tools?: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpConfig: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  costCeilingUsd: number;
  outputSchema?: object;
};

export type SessionState = {
  status: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
  costUsd: number;
  numTurns: number;
  durationMs: number;
  isError: boolean;
  /** Final text output from the session. */
  result: string;
  /** Harness-assigned session id (e.g. Claude Code session_id). */
  sessionId: string;
  /** `structured_output` when the spec set an outputSchema; unvalidated. */
  structured?: unknown;
};

export type SessionHandle = {
  id: string; // local handle id
};

export interface HarnessAdapter {
  /** Spawn the session and return immediately — does not wait for completion. */
  run(spec: SessionSpec): Promise<SessionHandle>;
  /** Poll for current state. */
  poll(id: string): Promise<SessionState>;
  interrupt(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  /** OS pid of the session process, when there is one — stored so `lantern kill` can signal it. */
  getPid?(id: string): number | undefined;
}
