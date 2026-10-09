/**
 * ClaudeCodeHarness — real HarnessAdapter that spawns `claude -p` and consumes
 * its stream-json output. Replaces FakeHarness in the daemon and CLI.
 *
 * Key decisions:
 * - Use --max-budget-usd instead of manually monitoring cost and killing.
 * - Use --session-id so our DB session.id == the harness session id.
 * - --output-format stream-json --verbose for live event consumption.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { HarnessAdapter, SessionHandle, SessionSpec, SessionState } from './types.ts';

type ProcessEntry = {
  spec: SessionSpec;
  sessionId: string;
  pid: number | undefined;
  promise: Promise<SessionState>;
  kill: () => void;
};

/** One line from a stream-json event stream. */
type StreamEvent = {
  type: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  structured_output?: unknown;
};

function parseStreamEvents(stdout: string): StreamEvent[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as StreamEvent];
      } catch {
        return [];
      }
    });
}

function resultFromEvents(events: StreamEvent[], sessionId: string): SessionState {
  const resultEvent = events.find((e) => e.type === 'result');

  if (resultEvent) {
    return {
      status: resultEvent.is_error ? 'failed' : 'done',
      costUsd: resultEvent.total_cost_usd ?? 0,
      numTurns: resultEvent.num_turns ?? 0,
      durationMs: resultEvent.duration_ms ?? 0,
      isError: resultEvent.is_error ?? false,
      result: resultEvent.result ?? '',
      sessionId: resultEvent.session_id ?? sessionId,
      structured: resultEvent.structured_output,
    };
  }

  // Fallback: no well-formed result event — treat as error
  return {
    status: 'failed',
    costUsd: 0,
    numTurns: 0,
    durationMs: 0,
    isError: true,
    result: 'no result event in stream output',
    sessionId,
  };
}

export function buildArgs(spec: SessionSpec, sessionId: string): string[] {
  const args: string[] = [
    '--print',
    spec.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    sessionId,
    '--max-budget-usd',
    String(spec.costCeilingUsd),
    '--max-turns',
    String(spec.maxTurns),
    '--mcp-config',
    spec.mcpConfig,
  ];

  // Children return a structured result (child-result.ts) in structured_output.
  if (spec.outputSchema) {
    args.push('--json-schema', JSON.stringify(spec.outputSchema));
  }

  if (spec.systemPromptFile) {
    args.push('--append-system-prompt-file', spec.systemPromptFile);
  }

  // Sandbox every session: --restricted confines file
  // tools to the working directory, ignores the operator's settings files and
  // guards settings/git/tool config; --strict-mcp-config loads only Lantern's
  // server, never the operator's account connectors; --tools names the only
  // built-ins that exist. An unset list means none, never the default set.
  args.push('--restricted', '--strict-mcp-config', '--tools', (spec.tools ?? []).join(','));

  // Tier-specific permission mode
  const permMode = spec.tier === 'read_only' ? 'dontAsk' : 'acceptEdits';
  args.push('--permission-mode', permMode);

  if (spec.allowedTools.length > 0) {
    args.push('--allowedTools', spec.allowedTools.join(','));
  }
  if (spec.disallowedTools.length > 0) {
    args.push('--disallowedTools', spec.disallowedTools.join(','));
  }

  return args;
}

export class ClaudeCodeHarness implements HarnessAdapter {
  private sessions = new Map<string, ProcessEntry>();

  async run(spec: SessionSpec): Promise<SessionHandle> {
    const handleId = randomUUID();
    const sessionId = randomUUID();
    const args = buildArgs(spec, sessionId);
    const startMs = Date.now();

    const child = spawn('claude', args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    // The raw stream goes to disk as it arrives — never truncated, and
    // still there if the daemon dies mid-turn.
    let transcript: WriteStream | null = null;
    if (spec.transcriptPath) {
      mkdirSync(dirname(spec.transcriptPath), { recursive: true });
      transcript = createWriteStream(spec.transcriptPath, { flags: 'a' });
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      transcript?.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    const promise = new Promise<SessionState>((resolve) => {
      let timedOut = false;
      const terminate = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
      };
      const timer = setTimeout(() => {
        // Resolve on 'close', not here: the stream may already hold a result
        // event with the real cost, and resolving early threw it away and
        // recorded the turn as free.
        timedOut = true;
        terminate();
      }, spec.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (transcript) {
          const t = transcript;
          transcript = null;
          t.end(() => finish(code));
          return;
        }
        finish(code);
      });

      const finish = (code: number | null) => {
        const events = parseStreamEvents(stdoutBuf);
        const state = resultFromEvents(events, sessionId);
        // Use actual wall-clock duration if not provided by the result event
        if (state.durationMs === 0) {
          (state as { durationMs: number }).durationMs = Date.now() - startMs;
        }
        if (timedOut) {
          const reported = events.some((e) => e.type === 'result');
          resolve({
            ...state,
            status: 'timeout',
            isError: true,
            // No result event: spend is unknown, and --max-budget-usd caps it
            // at the ceiling — charge that rather than $0 (Law 7 errs high).
            costUsd: reported ? state.costUsd : spec.costCeilingUsd,
            result: `session timed out after ${spec.timeoutMs}ms${reported ? '' : ' (cost unknown; charged at ceiling)'}`,
          });
        } else if (code === 143) {
          // SIGTERM — killed
          resolve({ ...state, status: 'killed', isError: true });
        } else if (code !== 0 && !state.isError && state.status === 'done') {
          // Non-zero exit but no explicit error in stream — treat as failed
          resolve({
            ...state,
            status: 'failed',
            isError: true,
            result: state.result || stderrBuf.slice(0, 500),
          });
        } else {
          resolve(state);
        }
      };

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 'failed',
          costUsd: 0,
          numTurns: 0,
          durationMs: Date.now() - startMs,
          isError: true,
          result: err.message,
          sessionId,
        });
      });
    });

    const killFn = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
    };

    this.sessions.set(handleId, {
      spec,
      sessionId,
      pid: child.pid,
      promise,
      kill: killFn,
    });

    return { id: handleId };
  }

  async poll(id: string): Promise<SessionState> {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`ClaudeCodeHarness: unknown session ${id}`);
    return entry.promise;
  }

  async interrupt(id: string): Promise<void> {
    this.sessions.get(id)?.kill();
  }

  async kill(id: string): Promise<void> {
    this.sessions.get(id)?.kill();
  }

  /** Returns the PID of the child process for a handle (used to store in sessions table). */
  getPid(id: string): number | undefined {
    return this.sessions.get(id)?.pid;
  }
}
