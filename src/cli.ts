import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cmdAgent,
  cmdDb,
  cmdDoctor,
  cmdInit,
  cmdKill,
  cmdPause,
  cmdResume,
  cmdStart,
  cmdStop,
  cmdUi,
} from './cli/control.ts';
import { cmdInbox, cmdTicket, cmdTickets, cmdTriage } from './cli/ledger.ts';
import { cmdPulse } from './cli/pulse.ts';
import { cmdLogs, cmdMetrics, cmdSessions, cmdStatus } from './cli/report.ts';
import type { CliCtx } from './cli/shared.ts';
import type { HarnessAdapter } from './harness/types.ts';
import { LANTERN_DIR } from './init.ts';

/**
 * The CLI surface. Each command lives in `src/cli/` — the ledger,
 * control, pulse and report modules — and `run` dispatches by name.
 */
export const USAGE = `lantern — a local heartbeat orchestrator

Usage: lantern <command> [options]

Commands:
  init                       Scaffold ~/.lantern, run migrations, create the first agent
  agent add <path>           Register or refresh an agent from its .agent.md
  start [--agent <name>]     Start the daemon (foreground; --daemon to detach)
  stop  [--agent <name>]     Stop the daemon for an agent (reads the PID file)
  pause | resume             Kill switch
  status                     Agents, live sessions, last 24h of pulses, spend, precision
  pulse --now [--dry-run] [--agent <id>]
                             Force a pulse; dry-run does gates + digest + prints the prompt
  tickets [--status <s>] [--search <q>]
                             List tickets
  ticket <id>                Full ticket with event history and links
  triage [accept|dismiss <id> [reason]]
                             Queue of needs_triage tickets, grouped by origin
  inbox                      Unanswered escalations
  inbox answer <id> <text>   Reply (no verdict; unblocks a blocking escalation)
  inbox approve <id> [text]  Approve — the only thing that lets a release start
  inbox reject <id> <reason> Reject (also revokes an earlier approve)
  sessions [--live]          The fleet
  kill <session>             Terminate one child
  logs <pulse-id>            Everything one pulse did
  metrics [--days <n>]       Pulses run vs. scheduled, findings, precision,
                             time to ticket and close, human touches, cost (default 30 days)
  db                         Open sqlite3 on the store
  doctor                     Verify harness, auth mode, log source, worktrees, migrations
  ui [--port <n>]            Local web page: status, inbox, triage, tickets, sessions, pulses

Options:
  -h, --help                 Show this help
  -v, --version              Show version
`;

/** Package version, read from package.json so it never drifts from the manifest. */
export function version(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Every command, by name. */
const COMMANDS: Record<string, (c: CliCtx) => number> = {
  init: cmdInit,
  doctor: cmdDoctor,
  agent: cmdAgent,
  tickets: cmdTickets,
  ticket: cmdTicket,
  triage: cmdTriage,
  inbox: cmdInbox,
  pause: cmdPause,
  resume: cmdResume,
  pulse: cmdPulse,
  db: cmdDb,
  ui: cmdUi,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  metrics: cmdMetrics,
  sessions: cmdSessions,
  kill: cmdKill,
  logs: cmdLogs,
};

/**
 * Parse argv (already sliced past node + script) and act.
 * Returns the process exit code; the caller (bin/lantern) sets `process.exitCode`.
 * Streams are injected so tests can capture output instead of writing to the tty.
 * opts.lanternDir overrides ~/.lantern for testing.
 */
export function run(
  argv: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  opts: { lanternDir?: string; harness?: HarnessAdapter } = {},
): number {
  const lanternDir = opts.lanternDir ?? process.env.LANTERN_DIR ?? LANTERN_DIR;
  const cmd = argv[0];

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out.write(USAGE);
    return 0;
  }

  if (cmd === '--version' || cmd === '-v') {
    out.write(`lantern ${version()}\n`);
    return 0;
  }

  const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (command) return command({ argv, out, err, lanternDir, harness: opts.harness });

  err.write(`lantern: unknown or unimplemented command '${cmd}'\n\n`);
  err.write(USAGE);
  return 2;
}
