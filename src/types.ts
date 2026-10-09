// Row types and value enums for the schema in migrations/.
// These are the canonical TypeScript representations of what lives in SQLite.

export type TicketKind =
  | 'bug'
  | 'enhancement'
  | 'chore'
  | 'docs'
  | 'investigation'
  | 'release'
  | 'question';

// Status vocabularies: the one copy of each list. SQL uses
// TERMINAL_SQL / LIVE_SQL; the page mirrors them in ui/js/vocab.js; vocab.test.ts
// holds all three to the schema's CHECK constraints.

export const TICKET_STATUSES = [
  'open',
  'triage',
  'staffed',
  'in_review',
  'blocked',
  'closed',
  'wontfix',
  'duplicate',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that end a ticket; only closeTicket sets them, with a resolution. */
export const TERMINAL_TICKET_STATUSES = ['closed', 'wontfix', 'duplicate'] as const;
export type TerminalTicketStatus = (typeof TERMINAL_TICKET_STATUSES)[number];
export const isTerminalTicket = (status: string): status is TerminalTicketStatus =>
  (TERMINAL_TICKET_STATUSES as readonly string[]).includes(status);

/** A SQL list literal from constants above — never from input. */
const sqlList = (values: readonly string[]) => `(${values.map((v) => `'${v}'`).join(',')})`;
/** `('closed','wontfix','duplicate')`, for `status IN` / `NOT IN`. */
export const TERMINAL_SQL = sqlList(TERMINAL_TICKET_STATUSES);

export type TicketPriority = 'p0' | 'p1' | 'p2' | 'p3';

export type TicketOrigin =
  | 'human'
  | 'collector:email'
  | 'collector:logs'
  | 'collector:docs'
  | 'collector:ci'
  | 'agent:self'
  | 'agent:child';

export type LinkRel = 'duplicates' | 'relates_to' | 'caused_by' | 'blocks' | 'supersedes';

// ─── Row shapes (what comes out of SELECT *) ──────────────────────────────────

export type Ticket = {
  id: number;
  agent_id: string | null;
  kind: TicketKind;
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  origin: TicketOrigin;
  origin_ref: string | null;
  fingerprint: string | null;
  needs_triage: 0 | 1;
  repo: string | null;
  branch: string | null;
  pr_url: string | null;
  resolution: string | null;
  opened_pulse: number | null;
  closed_pulse: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TicketEvent = {
  id: number;
  ticket_id: number;
  pulse_id: number | null;
  session_id: string | null;
  actor: string;
  event: string;
  payload: string | null; // JSON
  created_at: string;
};

export type TicketLink = {
  from_ticket: number;
  to_ticket: number;
  rel: LinkRel;
  note: string | null;
  created_at: string;
};

// ─── Agents ───────────────────────────────────────────────────────────────────

export type AgentState = 'running' | 'paused' | 'stopped' | 'tripped';

export type Agent = {
  id: string;
  display_name: string;
  config_path: string;
  mission: string;
  heartbeat_seconds: number;
  max_children: number;
  state: AgentState;
  workdir: string;
  paused_reason: string | null;
  last_pulse_at: string | null;
  next_pulse_at: string | null;
  created_at: string;
  updated_at: string;
};

// ─── Pulses ───────────────────────────────────────────────────────────────────

export type PulseStatus = 'running' | 'clean' | 'acted' | 'escalated' | 'error' | 'skipped';

export type Pulse = {
  id: number;
  agent_id: string;
  started_at: string;
  ended_at: string | null;
  window_start: string;
  window_end: string;
  status: PulseStatus;
  summary: string | null;
  cost_usd: number;
  duration_ms: number | null;
  session_id: string | null;
  error: string | null;
};

// ─── Pulse findings ───────────────────────────────────────────────────────────

export type PulseFindingOutcome = 'clean' | 'finding' | 'skipped' | 'error';

export type PulseFinding = {
  id: number;
  pulse_id: number;
  action_key: string;
  outcome: PulseFindingOutcome;
  detail: string | null;
  ticket_id: number | null;
  created_at: string;
};

// ─── Observations (noise suppression) ────────────────────────────────────────

export type Observation = {
  fingerprint: string;
  source: string;
  sample: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  pulse_count: number;
  last_pulse_id: number | null;
  ticket_id: number | null;
  suppressed: number; // 0 | 1
  suppress_until: string | null;
  suppress_reason: string | null;
  occurrences_at_suppress: number | null;
  pulse_count_at_suppress: number | null;
};

// ─── Sessions ────────────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  'starting',
  'running',
  'waiting',
  'done',
  'failed',
  'killed',
  'timeout',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A session that is queued or still running — what gate 3 and the UI count as live. */
export const LIVE_SESSION_STATUSES = ['starting', 'running', 'waiting'] as const;
export const isLiveSession = (status: string): boolean =>
  (LIVE_SESSION_STATUSES as readonly string[]).includes(status);
/** `('starting','running','waiting')`, for `status IN`. */
export const LIVE_SQL = sqlList(LIVE_SESSION_STATUSES);

export type SessionTierName = 'read_only' | 'write_branch' | 'release';

export type Session = {
  id: string;
  agent_id: string | null;
  parent_id: string | null;
  pulse_id: number | null;
  ticket_id: number | null;
  label: string | null;
  tier: SessionTierName;
  harness: string;
  model: string | null;
  worktree: string | null;
  branch: string | null;
  status: SessionStatus;
  cost_usd: number;
  num_turns: number | null;
  exit_code: number | null;
  result: string | null;
  transcript_path: string | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
};

// ─── Escalations: the human queue ─────────────────────────────────────────────

export type EscalationSeverity = 'fyi' | 'decide' | 'blocking';
export type EscalationVerdict = 'approve' | 'reject';

export type Escalation = {
  id: number;
  agent_id: string;
  pulse_id: number | null;
  ticket_id: number | null;
  severity: EscalationSeverity;
  question: string;
  context: string | null; // JSON
  options: string | null; // JSON array
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  /** the human's decision, when the answer is one. NULL for a plain answer. */
  verdict: EscalationVerdict | null;
  created_at: string;
};

// ─── Context injected by the caller into every write ─────────────────────────

export type EventContext = {
  actor: string;
  pulse_id?: number | null;
  session_id?: string | null;
};

// ─── ci.watch test results ─────────────────────────────────────────────

export type TestOutcome = 'pass' | 'fail' | 'error' | 'skip';

/** One testcase from a JUnit XML report (collectors/junit.ts). */
export type TestResult = {
  /** `classname#name` — stable across runs, the key history is kept by. */
  testId: string;
  classname: string;
  name: string;
  outcome: TestOutcome;
  ms: number;
  /** The failure, error or skip message plus its body, cut to 2000 characters. */
  message: string;
  /** Passed only after a rerun (Surefire's flakyFailure / flakyError). */
  flaky: boolean;
};
