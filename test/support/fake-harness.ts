/** A scripted HarnessAdapter for tests — no `claude` process. Moved out of src/. */
import type {
  HarnessAdapter,
  SessionHandle,
  SessionSpec,
  SessionState,
} from '../../src/harness/types.ts';

export type FakeResponse = {
  result: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  isError?: boolean;
  /** Returned as `structured` (App. C) — tests of structured child results. */
  structured?: unknown;
  /** Optional side-effect to run synchronously inside run() — used in tests to simulate MCP tool calls. */
  onRun?: () => void;
};

/**
 * Test double for HarnessAdapter.
 * Immediately resolves run() and returns the canned response on poll().
 * No network, no subprocess, no tokens spent.
 */
export class FakeHarness implements HarnessAdapter {
  private sessions = new Map<string, { spec: SessionSpec; response: FakeResponse }>();
  private nextId = 1;

  /** Responses to return in order; last entry repeats for all subsequent calls. */
  private readonly responses: FakeResponse[];

  constructor(responses: FakeResponse | FakeResponse[] = { result: 'ok', costUsd: 0 }) {
    this.responses = Array.isArray(responses) ? responses : [responses];
  }

  private nextResponse(): FakeResponse {
    const resp = this.responses[Math.min(this.nextId - 1, this.responses.length - 1)];
    return resp ?? { result: 'ok', costUsd: 0 };
  }

  async run(spec: SessionSpec): Promise<SessionHandle> {
    const id = `fake-${this.nextId++}`;
    const resp = this.nextResponse();
    resp.onRun?.();
    this.sessions.set(id, { spec, response: resp });
    return { id };
  }

  async poll(id: string): Promise<SessionState> {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`FakeHarness: unknown session ${id}`);
    const r = entry.response;
    return {
      status: r.isError ? 'failed' : 'done',
      costUsd: r.costUsd ?? 0,
      numTurns: r.numTurns ?? 1,
      durationMs: r.durationMs ?? 100,
      isError: r.isError ?? false,
      result: r.result,
      sessionId: id,
      structured: r.structured,
    };
  }

  async interrupt(_id: string): Promise<void> {}
  async kill(_id: string): Promise<void> {}

  /** Inspect calls made during a test. */
  /** Every spec this harness was asked to run, in order. */
  specs(): SessionSpec[] {
    return [...this.sessions.values()].map((s) => s.spec);
  }

  lastSpec(id?: string): SessionSpec | undefined {
    if (id) return this.sessions.get(id)?.spec;
    const last = [...this.sessions.values()].at(-1);
    return last?.spec;
  }

  callCount(): number {
    return this.sessions.size;
  }
}
