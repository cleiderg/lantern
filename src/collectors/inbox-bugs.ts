import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { priorArt } from '../store/prior-art.ts';
import { writePulseFinding } from '../store/pulses.ts';
import { createTicket } from '../store/tickets.ts';
import type { Agent } from '../types.ts';
import type { Classifier, Email, EmailClassification, InboxSource } from './types.ts';

// ── FileInboxSource ───────────────────────────────────────────────────────────

/**
 * Reads emails from a JSON fixture file (array of Email objects).
 * Returns only emails whose `date` falls within [since, until).
 * Returns an empty array if the file does not exist.
 */
export class FileInboxSource implements InboxSource {
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  fetch(since: string, until: string): Email[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const all = JSON.parse(raw) as Email[];
    return all.filter((e) => e.date >= since && e.date < until);
  }
}

// ── Default keyword classifier ────────────────────────────────────────────────

// Scores the *shape* of a bug report rather than matching a keyword. Most trackers' bug templates ask for reproduction steps and
// expected-vs-actual behaviour; feature and help templates ask for a solution or
// a problem description instead. The old single regex matched "issue", so every
// real issue report was a bug (63.7% real-bug precision on the Uptime Kuma trial).

const SIGNALS: Array<{ label: string; weight: number; pattern: RegExp }> = [
  // Evidence of a defect: templated reports and email reports both.
  {
    label: 'reproduction steps',
    weight: 3,
    pattern: /steps to reproduce|reproduction steps|to reproduce|how to reproduce|repro steps/i,
  },
  {
    label: 'quoted error or stack trace',
    weight: 2,
    pattern:
      /\n\s+at [\w.<>$]+ ?\(|traceback \(most recent call last\)|\b\w*(?:error|exception)\b:\s*\S/i,
  },
  {
    label: 'crash, exception or 5xx',
    weight: 2,
    pattern:
      /crash(?:es|ed|ing)?\b|\bexception\b|\bfatal\b|\bpanic\b|segfault|\b5\d\d (?:error|response)|(?:error|code|status) [45]\d\d\b/i,
  },
  {
    label: 'started after an update',
    weight: 1,
    pattern:
      /(?:since|after) (?:the |yesterday'?s |last |latest |upgrading|updating|update|upgrade|deploy)/i,
  },
  // Not a defect: feature requests, praise.
  {
    label: 'feature-request phrasing',
    weight: -4,
    pattern:
      /feature request|\[feature\]|feature description|would be (?:nice|great|helpful|useful)|please (?:add|support|implement)|add (?:support|an option|the ability)|(?:can|could) you add|i(?:'d| would) like (?:to|the ability)|\bsuggestion\b|\benhancement\b/i,
  },
  {
    label: 'thanks or praise',
    weight: -2,
    pattern: /\bthank(?:s| you)\b|love (?:this|your)|great (?:job|work|project|product)/i,
  },
];
/** Everyday failure language. Each distinct phrase counts once, at most +2 in all. */
const FAILURE_PHRASES = [
  /\bbroke(?:n)?\b/i,
  /\bfail(?:s|ed|ing|ure)?\b/i,
  /not working|doesn'?t work|stopped working|no longer works/i,
  /\bcannot\b|can'?t\b|unable to/i,
  /\berror\b/i,
  /\bbug\b/i,
];
/** Expected and actual behaviour, both stated: the strongest single sign of a bug report. */
const EXPECTED = /expected (?:behaviou?r|result|outcome)|\bexpected:/i;
const ACTUAL = /actual (?:behaviou?r|result|outcome)|\bactual:|instead,? (?:it|i get|i see)/i;
/** Help-seeking: a subject phrased as a question, or asking how to do something. */
const QUESTION =
  /\?\s*$|^(?:how|is it|is there|can i|does|why|what)\b|\[help\]|ask for help|describe your problem|how (?:do|can|to)\b|is (?:it|there) (?:possible|a way)|any (?:way|idea|advice)|need help|help needed/i;
const FAULT_PATTERN = /crash|exception|fatal|panic|\n\s+at [\w.<>$]+ ?\(/i;

export type BugEvidence = { score: number; signals: Array<{ label: string; weight: number }> };

/**
 * The labelled signals behind a message's score (the page shows exactly
 * the evidence that decided). `bugScore` is their sum, so the two cannot drift.
 */
export function bugEvidence(email: Email): BugEvidence {
  const text = `${email.subject}\n${email.body}`;
  const signals: BugEvidence['signals'] = [];
  for (const s of SIGNALS)
    if (s.pattern.test(text)) signals.push({ label: s.label, weight: s.weight });
  const phrases = Math.min(2, FAILURE_PHRASES.filter((p) => p.test(text)).length);
  if (phrases) signals.push({ label: 'failure phrases', weight: phrases });
  if (EXPECTED.test(text) && ACTUAL.test(text))
    signals.push({ label: 'expected and actual behaviour', weight: 3 });
  if (QUESTION.test(email.subject.trim()) || QUESTION.test(email.body.slice(0, 400))) {
    signals.push({ label: 'question or help phrasing', weight: -3 });
  }
  return { score: signals.reduce((n, s) => n + s.weight, 0), signals };
}

/** The bug score of one message; a bug at 2 or more. Exported for tests and tuning. */
export function bugScore(email: Email): number {
  return bugEvidence(email).score;
}

/**
 * Heuristic bug classifier for inbox.bugs. A model-based classifier is a
 * separate decision (it costs a call per message).
 */
export function keywordClassifier(emails: Email[]): EmailClassification[] {
  return emails.map((email) => ({
    is_bug: bugScore(email) >= 2,
    title: email.subject,
    severity: FAULT_PATTERN.test(`${email.subject}\n${email.body}`) ? 'fault' : 'warning',
    repro_steps: null,
  }));
}

// ── scanInbox ─────────────────────────────────────────────────────────────────

export type ScanInboxResult = {
  outcome: 'clean' | 'finding';
  fetched: number;
  filed: number;
  deduped: number;
};

/**
 * Run the `inbox.bugs` every-pulse action.
 *
 * 1. Fetch emails from the inbox source for the pulse window.
 * 2. Classify each email (default: keyword heuristic; injectable for tests).
 * 3. For each bug candidate: dedupe on `origin_ref` (message-id), run
 *    prior_art, file a ticket with `origin='collector:email'`.
 * 4. Re-checking threads is handled by the dedupe: a thread reply with a new
 *    message-id that passes classification will file a new ticket or be linked
 *    via prior_art. Exact-same message-id is skipped.
 */
export function scanInbox(
  db: Database.Database,
  agent: Agent,
  pulseId: number,
  window: { start: string; end: string },
  source: InboxSource,
  classify: Classifier = keywordClassifier,
): ScanInboxResult {
  const emails = source.fetch(window.start, window.end);

  if (emails.length === 0) {
    writePulseFinding(db, {
      pulseId,
      actionKey: 'inbox.bugs',
      outcome: 'clean',
      detail: 'no new messages in window',
    });
    return { outcome: 'clean', fetched: 0, filed: 0, deduped: 0 };
  }

  const classifications = classify(emails);
  let filed = 0;
  let deduped = 0;

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i] as Email;
    const cls = classifications[i] as EmailClassification;

    if (!cls.is_bug) continue;

    // Dedupe: skip if we already have a ticket for this message-id.
    const existing = db
      .prepare(
        `SELECT id FROM tickets
         WHERE origin_ref = ? AND origin = 'collector:email'
         LIMIT 1`,
      )
      .get(email.id);
    if (existing) {
      deduped++;
      continue;
    }

    const body =
      `**From:** ${email.from}\n` +
      `**Date:** ${email.date}\n` +
      `**Thread:** ${email.thread_id ?? '(none)'}\n\n` +
      `---\n\n${email.body}`;

    // Prior-art uses only the title so the FTS AND query stays tight enough
    // to find matches on a small corpus.  The full body is too many terms.
    const priors = priorArt(db, { title: cls.title }, {});

    const priorBlock =
      priors.length > 0
        ? `\n\n**Prior art:** ${priors.map((p) => `#${p.id} — ${p.title}`).join('; ')}`
        : '';

    const ticketId = createTicket(
      db,
      {
        kind: 'bug',
        title: cls.title,
        body: body + priorBlock,
        origin: 'collector:email',
        origin_ref: email.id,
        fingerprint: null,
        priority: cls.severity === 'fault' ? 'p1' : 'p2',
        agent_id: agent.id,
        opened_pulse: pulseId,
        needs_triage: true,
      },
      { actor: agent.display_name, pulse_id: pulseId },
    );

    writePulseFinding(db, {
      pulseId,
      actionKey: 'inbox.bugs',
      outcome: 'finding',
      detail: `#${ticketId}: ${cls.title.slice(0, 80)}`,
      ticketId,
    });
    filed++;
  }

  // One row whenever nothing new was filed — including when every
  // candidate was already ticketed, which used to leave no row at all.
  if (filed === 0) {
    const dupes = deduped > 0 ? `, ${deduped} already ticketed` : '';
    writePulseFinding(db, {
      pulseId,
      actionKey: 'inbox.bugs',
      outcome: 'clean',
      detail: `${emails.length} message(s) fetched, no new bug candidates${dupes}`,
    });
  }

  return {
    outcome: filed > 0 ? 'finding' : 'clean',
    fetched: emails.length,
    filed,
    deduped,
  };
}
