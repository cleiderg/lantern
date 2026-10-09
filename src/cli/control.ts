/**
 * Setup and control: `init`, `doctor`, `agent add`, `pause`/`resume`, the
 * daemon (`start`/`stop`), `kill`, `db` and `ui`.
 * Split out of cli.ts's one `run()` function.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  killSessionAction,
  launchDetached,
  pause,
  registerAgent,
  resume,
  stopAgent,
} from '../actions.ts';
import { ensureDefaultAgent, getAgent, listAgents } from '../agent.ts';
import { startDaemon, startRefusal } from '../daemon.ts';
import { daemonLogPath } from '../daemon-log.ts';
import { openDb } from '../db.ts';
import { formatDoctor, runDoctor } from '../doctor.ts';
import { initLantern } from '../init.ts';
import { writeMcpConfig } from '../mcp/config.ts';
import { startUiServer } from '../ui/server.ts';

import { type CliCtx, flagValue, report, requireDb } from './shared.ts';

export function cmdInit(c: CliCtx): number {
  const { out, err, lanternDir } = c;
  try {
    initLantern(lanternDir);
    const mcpPath = writeMcpConfig(lanternDir);
    out.write(`lantern: ${lanternDir} initialized\n`);
    out.write(`lantern: MCP config written to ${mcpPath}\n`);
    out.write(`lantern: attach with: claude -p --mcp-config ${mcpPath} "…"\n`);
    return 0;
  } catch (e) {
    err.write(`lantern init: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export function cmdDoctor(c: CliCtx): number {
  const { out, err, lanternDir } = c;
  const { checks, ok } = runDoctor({ lanternDir });
  const stream = ok ? out : err;
  stream.write(formatDoctor(checks));
  return ok ? 0 : 1;
}

// Register (or refresh) an agent from its .agent.md.
export function cmdAgent(c: CliCtx): number {
  const { argv, out, err } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  if (argv[1] !== 'add' || !argv[2]) {
    err.write('lantern agent: usage: lantern agent add <path/to/id.agent.md>\n');
    return 1;
  }
  const db = openDb(dbPath);
  try {
    return report(registerAgent(db, resolve(argv[2])), out, err, 'agent add');
  } finally {
    db.close();
  }
}

export function cmdPause(c: CliCtx): number {
  const { out, err, lanternDir } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    return report(pause(db, lanternDir), out, err, 'pause');
  } finally {
    db.close();
  }
}

export function cmdResume(c: CliCtx): number {
  const { out, err, lanternDir } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    return report(resume(db, lanternDir), out, err, 'resume');
  } finally {
    db.close();
  }
}

export function cmdStart(c: CliCtx): number {
  const { argv, out, err, lanternDir } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;

  const startAgentFlag = flagValue(argv, '--agent');

  // Refuse a tripped agent here too, so `--daemon` fails loudly in this
  // process instead of in a detached child nobody is watching.
  {
    const db = openDb(dbPath);
    try {
      const target = startAgentFlag
        ? (getAgent(db, startAgentFlag) ?? ensureDefaultAgent(db, lanternDir))
        : ensureDefaultAgent(db, lanternDir);
      const refusal = startRefusal(target);
      if (refusal) {
        err.write(`lantern start: ${refusal}\n`);
        return 1;
      }
    } finally {
      db.close();
    }
  }

  if (argv.includes('--daemon')) {
    const pid = launchDetached(
      argv.filter((a) => a !== '--daemon'),
      lanternDir,
    );
    out.write(`lantern: daemon started (pid ${pid}), logging to ${daemonLogPath(lanternDir)}\n`);
    return 0;
  }

  // Foreground mode: registers SIGTERM/SIGINT, keeps event loop alive, never returns normally.
  try {
    startDaemon(lanternDir, startAgentFlag);
  } catch (e) {
    err.write(`lantern start: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  return 0; // unreachable in foreground; process exits via signal handler
}

export function cmdStop(c: CliCtx): number {
  const { argv, out, err, lanternDir } = c;
  const stopAgentFlag = flagValue(argv, '--agent');
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    const agents = stopAgentFlag ? [getAgent(db, stopAgentFlag)].filter(Boolean) : listAgents(db);
    let stopped = 0;
    for (const agent of agents) {
      if (!agent) continue;
      const had = existsSync(join(lanternDir, `${agent.id}.pid`));
      report(stopAgent(db, lanternDir, agent.id), out, err, 'stop');
      if (had) stopped++;
    }
    if (stopped === 0 && !stopAgentFlag) out.write('lantern: no daemon PID files found\n');
  } finally {
    db.close();
  }
  return 0;
}

export function cmdKill(c: CliCtx): number {
  const { argv, out, err } = c;
  const sessionId = argv[1];
  if (!sessionId) {
    err.write('lantern kill: usage: lantern kill <session-id>\n');
    return 1;
  }
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const db = openDb(dbPath);
  try {
    return report(killSessionAction(db, sessionId), out, err, 'kill');
  } finally {
    db.close();
  }
}

// An interactive sqlite3 shell on the store.
export function cmdDb(c: CliCtx): number {
  const { err } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const r = spawnSync('sqlite3', [dbPath], { stdio: 'inherit' });
  if (r.error) {
    err.write(
      (r.error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'lantern db: sqlite3 not found on PATH — install it (macOS ships one at /usr/bin/sqlite3)\n'
        : `lantern db: ${r.error.message}\n`,
    );
    return 1;
  }
  return r.status ?? 0;
}

// the local page. Foreground; Ctrl-C stops it.
export function cmdUi(c: CliCtx): number {
  const { argv, out, err, lanternDir } = c;
  const dbPath = requireDb(c);
  if (!dbPath) return 1;
  const rawPort = flagValue(argv, '--port');
  const port = rawPort === undefined ? 4455 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    err.write(`lantern ui: invalid port '${rawPort}'\n`);
    return 1;
  }
  startUiServer({ lanternDir, port })
    .then((ui) => {
      out.write(`lantern: ui at ${ui.url}\n`);
      out.write(
        'lantern: local only (127.0.0.1); the token in that URL is required — Ctrl-C to stop\n',
      );
      process.on('SIGINT', () => ui.close().then(() => process.exit(0)));
    })
    .catch((e: unknown) => {
      err.write(`lantern ui: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
  return 0;
}
