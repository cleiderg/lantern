/**
 * Capability tiers mapped to Claude CLI flag sets.
 *
 * IMPORTANT: --allowedTools only pre-approves tools (skips confirmation prompts).
 * It does NOT remove other tools from the available set. --disallowedTools is the
 * only flag that actually blocks a tool regardless of permission mode.
 * Both flags must be set correctly for meaningful enforcement.
 */

import type { SessionTierName } from '../types.ts';

export type TierFlags = {
  /**
   * The built-in tools that exist at all in the session (`--tools`, with
   * `--restricted`). Everything else — account connectors, network and
   * scheduling tools, whatever a future Claude Code adds — is absent, not
   * merely unapproved.
   */
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: 'dontAsk' | 'acceptEdits';
};

const READ_ONLY_ALLOWED = [
  'mcp__lantern__*',
  // Git read operations only
  'Bash(git log *)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git status *)',
  'Bash(git blame *)',
  // Search and listing
  'Bash(rg *)',
  'Bash(grep *)',
  'Bash(ls *)',
  'Bash(find *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Read',
];

// Explicitly block the write surface for read_only sessions.
// --disallowedTools wins over --allowedTools, so these are hard blocks.
const READ_ONLY_DISALLOW = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent'];

// No unrestricted shell: edit, run the project's tests/scripts,
// commit, and push HEAD to a named branch. `permissionMode: acceptEdits` in a
// non-interactive run denies anything not listed here. The pre-push hook from
// worktree.ts is the primary Law 1 control; these lists are the backstop.
const READ_ONLY_TOOLS = ['Bash', 'Read'];
const WRITE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit'];

const WRITE_BRANCH_ALLOWED = [
  'mcp__lantern__*',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  // Same read/search commands as read_only
  ...READ_ONLY_ALLOWED.filter((t) => t.startsWith('Bash(')),
  'Bash(npm test)',
  'Bash(npm test *)',
  'Bash(npm run *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  // No push: the daemon pushes the session branch through the push guard when
  // the child finishes. App. B's `Bash(git push origin HEAD:*)` never
  // matched a real push anyway.
];

// App. B's three, plus the other spellings of the same pushes. `--no-verify`
// would skip the pre-push hook.
const WRITE_BRANCH_DISALLOW = [
  'Bash(git push origin main*)',
  'Bash(git push origin master*)',
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push --no-verify*)',
  'Bash(git push origin HEAD:main*)',
  'Bash(git push origin HEAD:master*)',
  'Bash(git push origin +*)',
  'Bash(git push * --force*)',
  'Bash(git push * -f*)',
  'Bash(git push * --no-verify*)',
  'WebFetch',
  'WebSearch',
  'Agent',
];

// release = write_branch + tag: the child tags its branch head; the daemon pushes branch and tag
// through the push guard. A child never pushes, tags included.
const RELEASE_ALLOWED = [...WRITE_BRANCH_ALLOWED, 'Bash(git tag *)'];

/** Per-agent additions: validated in agent-config.ts, write tiers only. */
export type TierExtras = { testCommands?: string[] };

const testEntries = (cmds: string[] = []) => cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);

export function tierFlags(tier: SessionTierName, extras: TierExtras = {}): TierFlags {
  switch (tier) {
    case 'read_only':
      return {
        tools: READ_ONLY_TOOLS,
        allowedTools: READ_ONLY_ALLOWED,
        disallowedTools: READ_ONLY_DISALLOW,
        permissionMode: 'dontAsk',
      };
    case 'write_branch':
      return {
        tools: WRITE_TOOLS,
        allowedTools: [...WRITE_BRANCH_ALLOWED, ...testEntries(extras.testCommands)],
        disallowedTools: WRITE_BRANCH_DISALLOW,
        permissionMode: 'acceptEdits',
      };
    case 'release':
      // Caller must verify escalation approval first.
      return {
        tools: WRITE_TOOLS,
        allowedTools: [...RELEASE_ALLOWED, ...testEntries(extras.testCommands)],
        disallowedTools: WRITE_BRANCH_DISALLOW,
        permissionMode: 'acceptEdits',
      };
  }
}
