/**
 * The structured result every child returns.
 *
 * Children run with `--json-schema` set to CHILD_RESULT_SCHEMA; the final
 * `result` event then carries a conforming `structured_output` (verified live
 * with stream-json, 2026-10-03). The model produced it, after reading
 * untrusted content, so it is validated here by hand (no dependency) and
 * treated as data: what conforms is kept, the rest dropped, and a result
 * without a valid outcome and summary is null — the session then falls back to
 * its free-text result instead of failing.
 */

export const CHILD_OUTCOMES = ['fixed', 'partial', 'blocked', 'no_action', 'needs_human'] as const;
const FOLLOW_UP_KINDS = ['bug', 'enhancement', 'chore', 'docs'] as const;
const CONFIDENCE = ['high', 'medium', 'low'] as const;

export type ChildOutcome = (typeof CHILD_OUTCOMES)[number];
export type FollowUpTicket = {
  kind: (typeof FOLLOW_UP_KINDS)[number];
  title: string;
  body: string;
};

export type ChildResult = {
  outcome: ChildOutcome;
  summary: string;
  root_cause?: string;
  files_touched?: string[];
  branch?: string;
  pr_url?: string;
  tests_added?: boolean;
  resolution?: string;
  follow_up_tickets?: FollowUpTicket[];
  confidence?: (typeof CONFIDENCE)[number];
};

/** The JSON schema every child result is held to. */
export const CHILD_RESULT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary'],
  properties: {
    outcome: { enum: [...CHILD_OUTCOMES] },
    summary: { type: 'string' },
    root_cause: { type: 'string' },
    files_touched: { type: 'array', items: { type: 'string' } },
    branch: { type: 'string' },
    pr_url: { type: 'string' },
    tests_added: { type: 'boolean' },
    resolution: { type: 'string' },
    follow_up_tickets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'title', 'body'],
        properties: {
          kind: { enum: [...FOLLOW_UP_KINDS] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    confidence: { enum: [...CONFIDENCE] },
  },
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T =>
  typeof v === 'string' && (set as readonly string[]).includes(v);

/** A conforming ChildResult, or null when the required fields are missing or wrong. */
export function parseChildResult(raw: unknown): ChildResult | null {
  if (!isObj(raw) || !oneOf(raw.outcome, CHILD_OUTCOMES) || typeof raw.summary !== 'string') {
    return null;
  }
  const out: ChildResult = { outcome: raw.outcome, summary: raw.summary };
  for (const key of ['root_cause', 'branch', 'pr_url', 'resolution'] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key] as string;
  }
  if (typeof raw.tests_added === 'boolean') out.tests_added = raw.tests_added;
  if (oneOf(raw.confidence, CONFIDENCE)) out.confidence = raw.confidence;
  if (Array.isArray(raw.files_touched)) {
    out.files_touched = raw.files_touched.filter((f): f is string => typeof f === 'string');
  }
  if (Array.isArray(raw.follow_up_tickets)) {
    out.follow_up_tickets = raw.follow_up_tickets
      .filter(
        (t): t is FollowUpTicket =>
          isObj(t) &&
          oneOf(t.kind, FOLLOW_UP_KINDS) &&
          typeof t.title === 'string' &&
          typeof t.body === 'string',
      )
      .map((t) => ({ kind: t.kind, title: t.title, body: t.body }));
  }
  return out;
}
