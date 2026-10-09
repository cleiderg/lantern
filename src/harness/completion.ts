/**
 * What a finished child does to its ticket (this was the nested
 * branches of session-runner's `recordCompletion`). Pure: the caller polls,
 * publishes and removes the worktree, then writes what this decides.
 *
 *   tag push failed            → error event, blocked (the branch is up, the release is not)
 *   branch/PR publish failed   → error event, blocked (work exists, nothing is up for review)
 *   otherwise: not done → open; done but blocked/needs_human → blocked; done → in_review,
 *              with tag_pushed / branch_pushed events and the branch or PR on the ticket
 */

import type { PublishResult } from '../pull-request.ts';
import type { TicketStatus } from '../types.ts';
import type { ChildOutcome } from './child-result.ts';

export type CompletionInput = {
  finalStatus: 'done' | 'timeout' | 'failed';
  /** App. C outcome, when the child returned a conforming result. */
  outcome: ChildOutcome | null;
  branch: string | null;
  pr: PublishResult | null;
  tag: { ok: true; tag: string } | { ok: false; error: string } | null;
  /** The branch a pushed branch is reviewed against (`git diff base...branch`). */
  reviewBase: string;
};

export type CompletionDecision = {
  /** The session's own event on the ticket — `timeout` included. */
  sessionEvent: 'completed' | 'timeout' | 'error';
  /** Further ticket events, in order, after the session event and follow-ups. */
  events: Array<{
    event: 'error' | 'tag_pushed' | 'branch_pushed';
    payload: Record<string, unknown>;
  }>;
  patch: { status: TicketStatus; branch?: string | null; pr_url?: string };
};

export function decideCompletion(i: CompletionInput): CompletionDecision {
  const sessionEvent =
    i.finalStatus === 'done' ? 'completed' : i.finalStatus === 'timeout' ? 'timeout' : 'error';
  const blocked = (reason: string): CompletionDecision => ({
    sessionEvent,
    events: [{ event: 'error', payload: { reason, branch: i.branch } }],
    patch: { status: 'blocked', branch: i.branch },
  });

  if (i.tag && !i.tag.ok) return blocked(`tag not pushed: ${i.tag.error}`);
  if (i.pr && !i.pr.ok) {
    const what = i.pr.stage === 'push' ? 'branch not pushed' : 'pull request not opened';
    return blocked(`${what}: ${i.pr.error}`);
  }

  const status: TicketStatus =
    i.finalStatus !== 'done'
      ? 'open'
      : i.outcome === 'blocked' || i.outcome === 'needs_human'
        ? 'blocked'
        : 'in_review';
  const events: CompletionDecision['events'] = [];
  if (i.tag?.ok)
    events.push({ event: 'tag_pushed', payload: { tag: i.tag.tag, branch: i.branch } });
  if (i.pr?.ok && i.pr.kind === 'branch' && i.branch) {
    // no PR here — the pushed branch is what a person reviews.
    events.push({
      event: 'branch_pushed',
      payload: {
        branch: i.branch,
        remote: i.pr.remote,
        review: `git diff ${i.reviewBase}...${i.branch}`,
        why_no_pr: i.pr.why,
      },
    });
  }
  const patch: CompletionDecision['patch'] = i.pr?.ok
    ? { status, branch: i.branch, ...(i.pr.kind === 'pr' ? { pr_url: i.pr.url } : {}) }
    : { status };
  return { sessionEvent, events, patch };
}
