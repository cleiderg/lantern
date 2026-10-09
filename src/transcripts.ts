/**
 * Full harness transcripts live in ~/.lantern/runs/<pulse-id>/<session>.jsonl.
 * They are never truncated: they are the only forensic record of why a child
 * did what it did.
 *
 * The harness writes the raw stream-json as it arrives; this module owns the
 * paths and turns a transcript into a summary a person can read (UI, CLI).
 * Transcript text is collected content — it may quote email bodies and log
 * lines — so callers render it as text only (Law 8).
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function orchestratorTranscriptPath(lanternDir: string, pulseId: number): string {
  return join(lanternDir, 'runs', String(pulseId), 'orchestrator.jsonl');
}

export function sessionTranscriptPath(
  lanternDir: string,
  pulseId: number,
  sessionId: string,
): string {
  // Session ids are UUIDs we mint; refuse anything that could leave runs/.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id '${sessionId}'`);
  return join(lanternDir, 'runs', String(pulseId), `${sessionId}.jsonl`);
}

export type TranscriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'call'; tool: string; input: string }
  | { kind: 'result'; isError: boolean; text: string };

export type TranscriptSummary = {
  init: { model: string; permissionMode: string; tools: string[]; mcpServers: string[] } | null;
  steps: TranscriptStep[];
  denials: Array<{ tool: string; input: string }>;
  end: { subtype: string; costUsd: number; turns: number; result: string } | null;
  unparsedLines: number;
  /** Byte offset after the last whole line read: pass it back to read only what is new. */
  nextOffset: number;
  /** The file was shorter than the offset asked for (replaced), so it was read from 0. */
  reset: boolean;
};

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** The one field of a tool input worth showing: a Bash command, a path, else the JSON. */
function describeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Json;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url']) {
      if (typeof o[key] === 'string') return o[key] as string;
    }
  }
  return str(input);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? str((c as Json).text) : str(c)))
      .join('\n');
  }
  return str(content);
}

/** Read the whole lines of a file from a byte offset; a half-written tail is left for later. */
function readLinesFrom(
  path: string,
  from: number,
): { lines: string[]; next: number; reset: boolean } {
  const size = statSync(path).size;
  const reset = from > size;
  const start = reset ? 0 : Math.max(0, from);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let end = buf.lastIndexOf(0x0a) + 1;
  // A last line with no newline counts once it is whole JSON (a finished run
  // may end that way); while a child is still writing it, it is not yet.
  if (end < buf.length) {
    try {
      JSON.parse(buf.subarray(end).toString('utf8'));
      end = buf.length;
    } catch {
      // still being written
    }
  }
  return { lines: buf.subarray(0, end).toString('utf8').split('\n'), next: start + end, reset };
}

/**
 * Parse a stream-json transcript, from `from` bytes on (a live child's
 * transcript is read incrementally). Null when the file does not exist.
 */
export function summarizeTranscript(path: string, from = 0): TranscriptSummary | null {
  if (!existsSync(path)) return null;
  const { lines, next, reset } = readLinesFrom(path, from);
  const out: TranscriptSummary = {
    init: null,
    steps: [],
    denials: [],
    end: null,
    unparsedLines: 0,
    nextOffset: next,
    reset,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      out.unparsedLines++;
      continue;
    }
    const content = ((e.message as Json | undefined)?.content ?? []) as Json[];
    if (e.type === 'system' && e.subtype === 'init') {
      out.init = {
        model: str(e.model),
        permissionMode: str(e.permissionMode),
        tools: Array.isArray(e.tools) ? (e.tools as unknown[]).map(str) : [],
        mcpServers: Array.isArray(e.mcp_servers)
          ? (e.mcp_servers as Json[]).map((m) => str(m.name))
          : [],
      };
    } else if (e.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text' && str(c.text).trim())
          out.steps.push({ kind: 'text', text: str(c.text) });
        if (c.type === 'tool_use')
          out.steps.push({ kind: 'call', tool: str(c.name), input: describeInput(c.input) });
      }
    } else if (e.type === 'user') {
      for (const c of content) {
        if (c.type === 'tool_result') {
          out.steps.push({
            kind: 'result',
            isError: c.is_error === true,
            text: resultText(c.content),
          });
        }
      }
    } else if (e.type === 'result') {
      out.end = {
        subtype: str(e.subtype),
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0,
        turns: typeof e.num_turns === 'number' ? e.num_turns : 0,
        result: str(e.result),
      };
      for (const d of (e.permission_denials ?? []) as Json[]) {
        out.denials.push({ tool: str(d.tool_name), input: describeInput(d.tool_input) });
      }
    }
  }
  return out;
}
