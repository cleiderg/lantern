/**
 * The shapes every `/api` route shares, and its small helpers. Every POST goes
 * through actions.ts — the functions the CLI calls — so the page cannot mean
 * anything different by "approve" or "pause" than the terminal.
 */

import type { ActionResult, Launcher } from '../../actions.ts';
import type { ClaudeRunner } from '../../claude-status.ts';
import type { Db } from '../../db.ts';

export type ApiContext = {
  db: Db;
  lanternDir: string;
  /** Path segments after `/api/`, e.g. ['tickets', '12']. */
  params: string[];
  query: URLSearchParams;
  /** Parsed JSON body (POST only). */
  body: Record<string, unknown>;
  /** Starts detached `lantern` processes (Start, Pulse now); injectable for tests. */
  launcher: Launcher;
  /** Runs the Claude test turn; injectable for tests. */
  claudeRunner?: ClaudeRunner;
};

export type ApiResponse = { status: number; json: unknown };
export type Route = (ctx: ApiContext) => ApiResponse;

export const ok = (json: unknown): ApiResponse => ({ status: 200, json });
export const fail = (status: number, error: string): ApiResponse => ({ status, json: { error } });

/** `/api/x/:id` → a positive integer id, or the 400 to return. */
export function idParam(params: string[]): number | ApiResponse {
  const id = Number(params[0]);
  return Number.isInteger(id) && id > 0 ? id : fail(400, `invalid id '${params[0] ?? ''}'`);
}

/** lists that grow without bound are paged: `?page=N`, 50 a page. */
export const PAGE_SIZE = 50;

/** The requested page (1-based), null when none was asked for, or a 400. */
export function pageParam(query: URLSearchParams): number | null | ApiResponse {
  const raw = query.get('page');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : fail(400, 'page must be a positive integer');
}

/** One page of rows: fetch one extra to know whether another page follows. */
export function paged<T>(page: number, fetch: (limit: number, offset: number) => T[]) {
  const rows = fetch(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
  return { rows: rows.slice(0, PAGE_SIZE), page, more: rows.length > PAGE_SIZE };
}

/** An action result as HTTP: 200 with messages, or the refusal with a fitting status. */
export function fromAction(r: ActionResult): ApiResponse {
  if (r.ok) return ok({ messages: r.messages });
  if (/not found/.test(r.error)) return fail(404, r.error);
  if (/already|does not need|is tripped/.test(r.error)) return fail(409, r.error);
  return fail(400, r.error);
}

/** A body field that must be a string when present. */
export function text(body: Record<string, unknown>, key: string): string | ApiResponse {
  const v = body[key] ?? '';
  return typeof v === 'string' ? v : fail(400, `${key} must be a string`);
}
