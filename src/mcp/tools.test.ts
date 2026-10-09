import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureDefaultAgent, upsertAgentFromConfig } from '../agent.ts';
import { loadAgentConfig } from '../agent-config.ts';
import { FileLogSource, scanLogs } from '../collectors/logs-scan.ts';
import { openDb } from '../db.ts';
import { initLantern } from '../init.ts';
import { answerEscalation } from '../store/escalations.ts';
import { createRunningPulse } from '../store/pulses.ts';
import { createTicket } from '../store/tickets.ts';
import { callTool as callToolDirect } from './tools.ts';

const SERVER_PATH = fileURLToPath(new URL('server.ts', import.meta.url));

// ── helpers (server is self-initialising via initLantern(ctx.lanternDir)) ───────────

type LineReader = { next: (timeoutMs?: number) => Promise<string> };

function spawnServer(
  lanternDir: string,
  tier = 'orchestrator',
  extraEnv: Record<string, string> = {},
): { proc: ChildProcess; reader: LineReader; send: (msg: object) => void } {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, LANTERN_DIR: lanternDir, LANTERN_TIER: tier, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];

  (proc.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const deliver = waiters.shift();
      if (deliver) deliver(line);
      else queue.push(line);
    }
  });

  const reader: LineReader = {
    next: (timeoutMs = 5000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms waiting for MCP response`)),
          timeoutMs,
        );
        const deliver = (line: string) => {
          clearTimeout(timer);
          resolve(line);
        };
        const line = queue.shift();
        if (line !== undefined) deliver(line);
        else waiters.push(deliver);
      }),
  };

  return {
    proc,
    reader,
    send: (msg) => {
      (proc.stdin as NodeJS.WritableStream).write(`${JSON.stringify(msg)}\n`);
    },
  };
}

async function handshake(send: (msg: object) => void, reader: LineReader): Promise<void> {
  send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  await reader.next();
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

type ToolResp = { result: { content: Array<{ type: string; text: string }>; isError?: true } };

async function callTool(
  send: (msg: object) => void,
  reader: LineReader,
  id: number,
  name: string,
  args: object,
): Promise<ToolResp> {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(await reader.next()) as ToolResp;
}

function txt(r: ToolResp): string {
  return r.result.content[0]?.text ?? '';
}

// ── acceptance test ──────────────────────────────────────────────────────

test('acceptance: file tickets, link, close, prior_art, rejection', {
  timeout: 20000,
}, async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  t.after(() => {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  await handshake(send, reader);
  let seq = 0;
  const id = () => ++seq;

  // ── file 3 tickets ──────────────────────────────────────────────────────────

  // Ticket 1: auth bug — keywords shared with the later query (ticket 4)
  await t.test('create ticket 1 (auth bug)', async () => {
    const r = await callTool(send, reader, id(), 'tickets_create', {
      kind: 'bug',
      title: 'Auth JWT token expires login session',
      body: 'Users logged out when JWT auth token expires during session',
      origin: 'human',
    });
    assert.equal(r.result.isError, undefined);
    assert.equal(JSON.parse(txt(r)).id, 1);
  });

  // Ticket 2: unrelated domain (no shared terms with auth/jwt/login)
  await t.test('create ticket 2 (unrelated)', async () => {
    const r = await callTool(send, reader, id(), 'tickets_create', {
      kind: 'bug',
      title: 'API rate limit returns 429 error',
      body: 'Handle HTTP 429 responses with exponential backoff retry',
      origin: 'human',
    });
    assert.equal(r.result.isError, undefined);
    assert.equal(JSON.parse(txt(r)).id, 2);
  });

  // Ticket 3: unrelated domain
  await t.test('create ticket 3 (unrelated)', async () => {
    const r = await callTool(send, reader, id(), 'tickets_create', {
      kind: 'chore',
      title: 'Database connection pool exhausted',
      body: 'Connection pool fills under peak traffic',
      origin: 'human',
    });
    assert.equal(r.result.isError, undefined);
    assert.equal(JSON.parse(txt(r)).id, 3);
  });

  // ── link tickets ────────────────────────────────────────────────────────────

  await t.test('link ticket 1 → 2 (relates_to)', async () => {
    const r = await callTool(send, reader, id(), 'tickets_link', {
      from_ticket: 1,
      to_ticket: 2,
      rel: 'relates_to',
    });
    assert.equal(r.result.isError, undefined);
    assert.match(txt(r), /#1/);
  });

  await t.test('link ticket 1 → 3 (relates_to)', async () => {
    const r = await callTool(send, reader, id(), 'tickets_link', {
      from_ticket: 1,
      to_ticket: 3,
      rel: 'relates_to',
    });
    assert.equal(r.result.isError, undefined);
  });

  // ── close ticket 1 with resolution ─────────────────────────────────────────

  await t.test('close ticket 1 with resolution', async () => {
    const r = await callTool(send, reader, id(), 'tickets_close', {
      id: 1,
      status: 'closed',
      // Resolution reuses auth/jwt/token/session/expires — feeds FTS for ticket 4's query
      resolution: 'Fixed JWT auth token expires: login session tokens now last 24h',
    });
    assert.equal(r.result.isError, undefined);
    assert.match(txt(r), /'closed'/);
  });

  // ── close without resolution is rejected ────────────────────────────────────

  await t.test('close-without-resolution is rejected', async () => {
    const r = await callTool(send, reader, id(), 'tickets_close', {
      id: 2,
      status: 'closed',
      resolution: '',
    });
    assert.equal(r.result.isError, true, 'empty resolution must be rejected');
  });

  // ── prior_art on ticket 4 surfaces the closed ticket 1 ─────────────────────
  //
  // Ticket 4 title/body shares auth/jwt/token/login/session/expires/users/logged/out
  // with ticket 1 (title + body + resolution). Tickets 2 and 3 have none of these.
  // Ticket 1 is closed+resolved → 2× BM25 bias → ranks first.

  await t.test('tickets_create ticket 4 — prior_art surfaces ticket 1', async () => {
    const r = await callTool(send, reader, id(), 'tickets_create', {
      kind: 'bug',
      title: 'Auth JWT token login session expires',
      body: 'Users logged out auth token session',
      origin: 'human',
    });
    assert.equal(r.result.isError, undefined);
    const body = JSON.parse(txt(r)) as {
      id: number;
      prior_art: Array<{ id: number; status: string }>;
    };
    assert.equal(body.id, 4);
    assert.ok(body.prior_art.length > 0, 'prior_art must be non-empty');
    const first = body.prior_art[0];
    assert.ok(first !== undefined);
    assert.equal(first.id, 1, 'closed+resolved ticket 1 must rank first');
    assert.equal(first.status, 'closed');
  });

  // ── read_only tier: tickets_link is rejected ────────────────────────────────

  await t.test('read_only tier: tickets_link rejected', async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'lantern-tools-ro-'));
    const { proc: proc2, reader: reader2, send: send2 } = spawnServer(tmpDir2, 'read_only');
    try {
      await handshake(send2, reader2);
      const r = await callTool(send2, reader2, 1, 'tickets_link', {
        from_ticket: 1,
        to_ticket: 2,
        rel: 'relates_to',
      });
      assert.equal(r.result.isError, true, 'read_only must not write links');
      assert.match(txt(r), /read_only/);
    } finally {
      proc2.kill();
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ── Individual tool smoke tests ───────────────────────────────────────────────

test('tickets_get returns ticket, events, and links', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-get-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  try {
    await handshake(send, reader);

    // create
    await callTool(send, reader, 1, 'tickets_create', {
      kind: 'bug',
      title: 'Null pointer in auth handler',
      body: 'NPE thrown on missing auth header',
      origin: 'human',
    });

    // get
    const r = await callTool(send, reader, 2, 'tickets_get', { id: 1 });
    assert.equal(r.result.isError, undefined);
    const body = JSON.parse(txt(r)) as {
      ticket: { id: number; title: string };
      events: unknown[];
      links: unknown[];
    };
    assert.equal(body.ticket.id, 1);
    assert.equal(body.ticket.title, 'Null pointer in auth handler');
    assert.ok(Array.isArray(body.events));
    assert.ok(Array.isArray(body.links));
    assert.ok(body.events.length >= 1, 'created event must exist');
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tickets_search finds ticket by FTS query', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-search-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  try {
    await handshake(send, reader);

    await callTool(send, reader, 1, 'tickets_create', {
      kind: 'bug',
      title: 'Memory leak in websocket handler',
      body: 'Heap grows without bound on long-lived websocket connections',
      origin: 'human',
    });

    const r = await callTool(send, reader, 2, 'tickets_search', { query: 'memory leak websocket' });
    assert.equal(r.result.isError, undefined);
    const rows = JSON.parse(txt(r)) as Array<{ id: number; title: string }>;
    assert.ok(rows.length >= 1);
    assert.equal(rows[0]?.id, 1);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tickets_get returns error for missing ticket', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-missing-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'tickets_get', { id: 999 });
    assert.equal(r.result.isError, true);
    assert.match(txt(r), /not found/);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('playbook_run with unknown key returns structured unsupported', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'does.not.exist' });
    assert.equal(r.result.isError, undefined, 'must not return isError for unknown key');
    const body = JSON.parse(txt(r)) as { supported: boolean; reason: string };
    assert.equal(body.supported, false, 'unknown key must return supported:false');
    assert.match(body.reason, /unknown playbook key/);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const LOGS_FIXTURE = fileURLToPath(new URL('../../test/fixtures/logs.ndjson', import.meta.url));
const INBOX_FIXTURE = fileURLToPath(new URL('../../test/fixtures/inbox.json', import.meta.url));

/**
 * Seed a migrated DB with an agent and a running pulse whose window covers the
 * fixtures, and return the ids the MCP server needs in its env.
 * playbook_run resolves its context at server start, so this must happen first.
 */
function seedPulseContext(lanternDir: string): { agentId: string; pulseId: number } {
  initLantern(lanternDir);
  const db = openDb(join(lanternDir, 'lantern.db'));
  try {
    const agent = ensureDefaultAgent(db, lanternDir);
    const pulseId = createRunningPulse(db, {
      agentId: agent.id,
      windowStart: '2026-09-07T00:00:00.000Z',
      windowEnd: '2026-09-08T00:00:00.000Z',
    });
    return { agentId: agent.id, pulseId };
  } finally {
    db.close();
  }
}

test('logs.scan with no configured source is unsupported, not an error', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-nosrc-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  // LANTERN_LOG_SOURCE blanked: an unset source is a configuration gap, not a fault.
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
    LANTERN_LOG_SOURCE: '',
  });

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'logs.scan' });
    assert.equal(r.result.isError, undefined, 'a missing source must not surface as a tool error');
    const body = JSON.parse(txt(r)) as { supported: boolean; reason: string };
    assert.equal(body.supported, false);
    assert.match(body.reason, /LANTERN_LOG_SOURCE/);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('playbook_run inbox.bugs never scans — with a configured source and no collect-phase finding it says none ran', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-noscan-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
    LANTERN_INBOX_SOURCE: INBOX_FIXTURE,
  });
  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'inbox.bugs' });
    assert.equal(r.result.isError, undefined, txt(r));
    const body = JSON.parse(txt(r)) as { supported: boolean; reason: string };
    assert.equal(body.supported, false);
    assert.match(body.reason, /collect phase/);
    const db = openDb(join(tmpDir, 'lantern.db'));
    const n = (db.prepare('SELECT count(*) AS n FROM pulse_findings').get() as { n: number }).n;
    const tickets = (db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n;
    db.close();
    assert.equal(n, 0, 'no finding written — nothing was scanned');
    assert.equal(tickets, 0, 'the inbox fixture was not read');
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('logs.scan without pulse context fails loudly rather than scanning blind', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-noctx-'));
  seedPulseContext(tmpDir);
  // No LANTERN_PULSE_ID: a scan with nowhere to record its finding must not proceed.
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_LOG_SOURCE: LOGS_FIXTURE,
  });

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'logs.scan' });
    assert.equal(r.result.isError, true);
    assert.match(txt(r), /LANTERN_AGENT_ID and LANTERN_PULSE_ID/);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── heartbeat.selfcheck playbook ─────────────────────────────────────────────
// Resolves the previously-open "unknown playbook key: heartbeat.selfcheck" gap
// — found live via dogfooding, joe's
// pulses could never report a real self-check result.

test('playbook_run heartbeat.selfcheck: healthy for a live running pulse', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-selfcheck-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'heartbeat.selfcheck' });
    assert.equal(r.result.isError, undefined, txt(r));
    const body = JSON.parse(txt(r)) as { healthy: boolean; problems: string[] };
    assert.equal(body.healthy, true);
    assert.deepEqual(body.problems, []);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('playbook_run heartbeat.selfcheck: fails loudly without pulse context', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-pr-selfcheck-noctx-'));
  seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator');

  try {
    await handshake(send, reader);
    const r = await callTool(send, reader, 1, 'playbook_run', { key: 'heartbeat.selfcheck' });
    assert.equal(r.result.isError, true);
    assert.match(txt(r), /LANTERN_PULSE_ID/);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('observation_record upserts and checks threshold', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-obs-'));
  const { proc, reader, send } = spawnServer(tmpDir);

  try {
    await handshake(send, reader);

    const fp = 'sha1:deadbeef';

    // First call: occurrences=1, pulse_count=1 — not ticketable
    let r = await callTool(send, reader, 1, 'observation_record', {
      fingerprint: fp,
      source: 'logs',
      sample: 'NullPointerException at auth.handler:42',
    });
    assert.equal(r.result.isError, undefined);
    let body = JSON.parse(txt(r)) as {
      ticketable: boolean;
      occurrences: number;
      pulse_count: number;
    };
    assert.equal(body.ticketable, false);
    assert.equal(body.occurrences, 1);

    // Fault severity → immediately ticketable
    r = await callTool(send, reader, 2, 'observation_record', {
      fingerprint: 'sha1:faultfp',
      source: 'logs',
      sample: 'segfault in auth',
      severity: 'fault',
    });
    body = JSON.parse(txt(r)) as typeof body;
    assert.equal(body.ticketable, true);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── staff_ticket gates (blocking escalation, release approval) ────

test('staff_ticket is refused while an open blocking escalation exists on the ticket', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-blocking-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });

  try {
    await handshake(send, reader);

    const created = await callTool(send, reader, 1, 'tickets_create', {
      kind: 'bug',
      title: 'Flaky test in CI',
      body: 'Investigate flaky test',
      origin: 'human',
    });
    const ticketId = (JSON.parse(txt(created)) as { id: number }).id;

    const escalated = await callTool(send, reader, 2, 'escalate', {
      severity: 'blocking',
      question: 'Confirm before touching CI config?',
      ticket_id: ticketId,
    });
    const escalationId = (JSON.parse(txt(escalated)) as { id: number }).id;

    const staffed = await callTool(send, reader, 3, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'read_only',
    });
    assert.equal(staffed.result.isError, true, 'a blocking escalation must refuse staffing');
    assert.match(txt(staffed), /blocked_by_escalation/);
    assert.match(txt(staffed), new RegExp(`#${escalationId}`));

    // Answer it out-of-band (simulates `lantern inbox answer`) — staffing must then succeed.
    const db = openDb(join(tmpDir, 'lantern.db'));
    answerEscalation(db, escalationId, 'go ahead', 'human');
    db.close();

    const staffedAgain = await callTool(send, reader, 4, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'read_only',
    });
    assert.equal(staffedAgain.result.isError, undefined, txt(staffedAgain));
    assert.equal((JSON.parse(txt(staffedAgain)) as { status: string }).status, 'queued');
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('release-tier staff_ticket requires a human approve verdict on the ticket', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-release-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });

  try {
    await handshake(send, reader);

    const created = await callTool(send, reader, 1, 'tickets_create', {
      kind: 'release',
      title: 'Cut v2.3.0',
      body: 'Tag and publish the release',
      origin: 'human',
    });
    const ticketId = (JSON.parse(txt(created)) as { id: number }).id;

    const refused = await callTool(send, reader, 2, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.equal(refused.result.isError, true, 'release tier with no approval must be refused');
    assert.match(txt(refused), /release_requires_approval/);

    // a plain answer is not approval — only an explicit approve verdict.
    const ask = async (n: number) =>
      (
        JSON.parse(
          txt(
            await callTool(send, reader, n, 'escalate', {
              severity: 'decide',
              question: 'OK to release now?',
              ticket_id: ticketId,
            }),
          ),
        ) as { id: number }
      ).id;
    const db = openDb(join(tmpDir, 'lantern.db'));
    answerEscalation(db, await ask(3), 'yes, proceed', 'human');
    const stillRefused = await callTool(send, reader, 5, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.equal(stillRefused.result.isError, true, 'an answer without a verdict is not approval');
    answerEscalation(db, await ask(6), 'yes, proceed', 'human', 'approve');
    db.close();

    const allowed = await callTool(send, reader, 4, 'staff_ticket', {
      ticket_id: ticketId,
      tier: 'release',
    });
    assert.equal(allowed.result.isError, undefined, txt(allowed));
    assert.equal((JSON.parse(txt(allowed)) as { status: string }).status, 'queued');
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── tickets_update cannot close a ticket ─────────────────────────
// A terminal status set through tickets_update skipped closeTicket entirely:
// no resolution, no closed_at, no wontfix suppression. Reproduced from a
// read_only child before the fix.

test('tickets_update refuses a terminal status and leaves the ticket open', {
  timeout: 10000,
}, async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-update-'));
  const { proc, reader, send } = spawnServer(tmpDir, 'read_only');
  t.after(() => {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  await handshake(send, reader);

  await callTool(send, reader, 1, 'tickets_create', {
    kind: 'bug',
    title: 'Retry storm',
    body: 'b',
    origin: 'agent:child',
  });
  let seq = 1;
  for (const status of ['closed', 'wontfix', 'duplicate']) {
    const r = await callTool(send, reader, ++seq, 'tickets_update', { id: 1, status });
    assert.equal(r.result.isError, true, `status '${status}' must be refused`);
    assert.match(txt(r), /tickets_close/);
  }
  const got = JSON.parse(txt(await callTool(send, reader, ++seq, 'tickets_get', { id: 1 })));
  assert.equal(got.ticket.status, 'open');
  assert.equal(got.ticket.closed_at, null);

  const ok = await callTool(send, reader, ++seq, 'tickets_update', { id: 1, status: 'blocked' });
  assert.equal(ok.result.isError, undefined, 'non-terminal statuses still update');
});

// ── staff_ticket validates what it queues ────────────────────────

test('staff_ticket refuses a missing ticket, a closed ticket, a second live session, and no agent', {
  timeout: 10000,
}, async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-staff-guards-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });
  const bare = spawnServer(tmpDir, 'orchestrator', { LANTERN_PULSE_ID: String(pulseId) });
  t.after(() => {
    proc.kill();
    bare.proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  await handshake(send, reader);
  await handshake(bare.send, bare.reader);

  let seq = 0;
  const call = (name: string, args: object) => callTool(send, reader, ++seq, name, args);
  await call('tickets_create', { kind: 'bug', title: 'Open one', body: 'b', origin: 'human' });
  await call('tickets_create', { kind: 'bug', title: 'Done one', body: 'b', origin: 'human' });
  await call('tickets_close', { id: 2, status: 'closed', resolution: 'fixed elsewhere' });

  const missing = await call('staff_ticket', { ticket_id: 999, tier: 'read_only' });
  assert.equal(missing.result.isError, true);
  assert.match(txt(missing), /not found/);

  const closed = await call('staff_ticket', { ticket_id: 2, tier: 'read_only' });
  assert.equal(closed.result.isError, true);
  assert.match(txt(closed), /closed/);

  const first = await call('staff_ticket', { ticket_id: 1, tier: 'read_only' });
  assert.equal(first.result.isError, undefined, txt(first));
  const second = await call('staff_ticket', { ticket_id: 1, tier: 'read_only' });
  assert.equal(second.result.isError, true);
  assert.match(txt(second), /already has a live session/);

  const noAgent = await callTool(bare.send, bare.reader, 1, 'staff_ticket', {
    ticket_id: 1,
    tier: 'read_only',
  });
  assert.equal(noAgent.result.isError, true);
  assert.match(txt(noAgent), /LANTERN_AGENT_ID/);

  const db = openDb(join(tmpDir, 'lantern.db'));
  try {
    const n = (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
    assert.equal(n, 1, 'only the one valid request queued a session');
  } finally {
    db.close();
  }
});

// ── a collector runs once per pulse ──────────────────────────────
// Decision 11 makes the daemon's collect phase the place collectors run; a
// second scan of the same window in the same pulse double-counted
// observation occurrences (only pulse_count was per-pulse guarded).

function scanState(lanternDir: string, pulseId: number) {
  const db = openDb(join(lanternDir, 'lantern.db'));
  try {
    const occ = (
      db.prepare('SELECT coalesce(sum(occurrences), 0) AS n FROM observations').get() as {
        n: number;
      }
    ).n;
    const findings = (
      db
        .prepare(
          `SELECT count(*) AS n FROM pulse_findings WHERE pulse_id = ? AND action_key = 'logs.scan'`,
        )
        .get(pulseId) as { n: number }
    ).n;
    return { occ, findings };
  } finally {
    db.close();
  }
}

test('playbook_run logs.scan after the collect phase returns that result, no rescan', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-once-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  // The daemon's collect phase, in-process.
  const db = openDb(join(tmpDir, 'lantern.db'));
  const agent = ensureDefaultAgent(db, tmpDir);
  const w = db.prepare('SELECT window_start, window_end FROM pulses WHERE id = ?').get(pulseId) as {
    window_start: string;
    window_end: string;
  };
  scanLogs(
    db,
    agent,
    pulseId,
    { start: w.window_start, end: w.window_end },
    new FileLogSource(LOGS_FIXTURE),
  );
  db.close();
  const before = scanState(tmpDir, pulseId);
  assert.ok(before.occ > 0 && before.findings > 0, 'collect phase scanned');

  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
    LANTERN_LOG_SOURCE: LOGS_FIXTURE,
  });
  try {
    await handshake(send, reader);
    for (let i = 1; i <= 2; i++) {
      const r = await callTool(send, reader, i, 'playbook_run', { key: 'logs.scan' });
      assert.equal(r.result.isError, undefined, txt(r));
      const body = JSON.parse(txt(r)) as { alreadyRan?: boolean; findings?: unknown[] };
      assert.equal(body.alreadyRan, true, `call ${i} reuses this pulse's scan`);
      assert.equal(body.findings?.length, before.findings);
    }
    assert.deepEqual(scanState(tmpDir, pulseId), before, 'occurrences and findings unchanged');
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── one finding per action per pulse ──────────────────────────────
// Live demo: playbooks recorded their own row, then the model restated each
// one through pulse_finding — two rows per action on every pulse.

test('pulse_finding: an action already recorded this pulse is not written again', {
  timeout: 10000,
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-tools-dedupe-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const db = openDb(join(tmpDir, 'lantern.db'));
  db.prepare(
    `INSERT INTO pulse_findings (pulse_id, action_key, outcome, detail) VALUES (?, 'logs.scan', 'clean', 'collect phase')`,
  ).run(pulseId);
  db.close();
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });
  try {
    await handshake(send, reader);
    const again = await callTool(send, reader, 1, 'pulse_finding', {
      action_key: 'logs.scan',
      outcome: 'clean',
      detail: 'restating the playbook',
    });
    assert.equal(again.result.isError, undefined, 'not an error: the model should not retry');
    assert.match(txt(again), /already recorded/);
    const fresh = await callTool(send, reader, 2, 'pulse_finding', {
      action_key: 'staffing',
      outcome: 'clean',
    });
    assert.match(txt(fresh), /Finding recorded/);

    const check = openDb(join(tmpDir, 'lantern.db'));
    const rows = check
      .prepare('SELECT action_key, detail FROM pulse_findings WHERE pulse_id = ? ORDER BY id')
      .all(pulseId);
    check.close();
    assert.deepEqual(rows, [
      { action_key: 'logs.scan', detail: 'collect phase' },
      { action_key: 'staffing', detail: null },
    ]);
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('staff_ticket: refuses a ticket another agent owns', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-staff-owner-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const db = openDb(join(tmpDir, 'lantern.db'));
  db.prepare(
    `INSERT INTO agents (id, display_name, config_path, mission, workdir) VALUES ('other', 'Other', 'x', 'm', ?)`,
  ).run(tmpDir);
  const theirs = createTicket(
    db,
    { kind: 'bug', title: 't', body: 'b', origin: 'agent:self', agent_id: 'other' },
    { actor: 't' },
  );
  const mine = createTicket(
    db,
    { kind: 'bug', title: 't', body: 'b', origin: 'agent:self', agent_id: agentId },
    { actor: 't' },
  );
  const unowned = createTicket(
    db,
    { kind: 'bug', title: 't', body: 'b', origin: 'human' },
    { actor: 't' },
  );
  db.close();
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });
  try {
    await handshake(send, reader);
    const refused = await callTool(send, reader, 1, 'staff_ticket', {
      ticket_id: theirs,
      tier: 'read_only',
    });
    assert.equal(refused.result.isError, true);
    assert.match(txt(refused), /belongs to agent 'other'/);
    assert.equal(
      (await callTool(send, reader, 2, 'staff_ticket', { ticket_id: mine, tier: 'read_only' }))
        .result.isError,
      undefined,
    );
    assert.equal(
      (await callTool(send, reader, 3, 'staff_ticket', { ticket_id: unowned, tier: 'read_only' }))
        .result.isError,
      undefined,
    );
  } finally {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── The human triage gate holds in the tool layer ──────────
// The PetClinic orchestrator cleared needs_triage on its own collector tickets
// and staffed one. Accepting a ticket is a human act (`lantern triage accept`, the
// page); the agent cannot do it, and staff_ticket refuses an untriaged ticket.

test('the agent cannot accept a ticket, and staff_ticket refuses one still awaiting triage', {
  timeout: 10000,
}, async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-triage-gate-'));
  const { agentId, pulseId } = seedPulseContext(tmpDir);
  const { proc, reader, send } = spawnServer(tmpDir, 'orchestrator', {
    LANTERN_AGENT_ID: agentId,
    LANTERN_PULSE_ID: String(pulseId),
  });
  t.after(() => {
    proc.kill();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  await handshake(send, reader);
  let seq = 0;
  const call = (name: string, args: object) => callTool(send, reader, ++seq, name, args);

  // A collector's ticket arrives needing triage.
  const db = openDb(join(tmpDir, 'lantern.db'));
  const id = createTicket(
    db,
    {
      kind: 'bug',
      title: 'From the inbox',
      body: 'b',
      origin: 'collector:email',
      needs_triage: true,
      agent_id: agentId,
    },
    { actor: 'collector' },
  );
  db.close();

  const accept = await call('tickets_update', { id, needs_triage: false });
  assert.equal(accept.result.isError, true);
  assert.match(txt(accept), /only a human accepts/);

  const staff = await call('staff_ticket', { ticket_id: id, tier: 'read_only' });
  assert.equal(staff.result.isError, true);
  assert.match(txt(staff), /awaiting triage/);

  // Flagging a ticket FOR triage stays allowed (the agent's own voice).
  const flag = await call('tickets_update', { id, needs_triage: true, priority: 'p1' });
  assert.equal(flag.result.isError, undefined, txt(flag));

  // Once a human accepts it, the agent may staff it.
  const db2 = openDb(join(tmpDir, 'lantern.db'));
  db2.prepare('UPDATE tickets SET needs_triage = 0 WHERE id = ?').run(id);
  db2.close();
  const ok = await call('staff_ticket', { ticket_id: id, tier: 'read_only' });
  assert.equal(ok.result.isError, undefined, txt(ok));
});

test('tickets_search: a query with code in it matches (it shares the prior-art FTS builder)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-search-fts-'));
  try {
    const { agentId, pulseId } = seedPulseContext(tmpDir);
    const db = openDb(join(tmpDir, 'lantern.db'));
    createTicket(
      db,
      {
        kind: 'bug',
        title: '[logs] Servlet.service() for servlet [dispatcherServlet] threw exception',
        body: 'b',
        origin: 'collector:logs',
      },
      { actor: 'x' },
    );
    const r = callToolDirect(
      db,
      {
        lanternDir: tmpDir,
        agentId,
        pulseId,
        sessionId: null,
        ticketId: null,
        tier: 'orchestrator',
      },
      { actor: 'test' },
      'tickets_search',
      {
        query: 'Servlet.service() threw',
      },
    );
    db.close();
    assert.equal(r.isError, undefined, String(r.content[0]?.text));
    const rows = JSON.parse(r.content[0]?.text ?? '[]') as { title: string }[];
    assert.equal(rows.length, 1, String(r.content[0]?.text));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("pulse_finding: keys are the agent's actions or a built-in; staff* aliases map to staffing", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-action-keys-'));
  try {
    initLantern(tmpDir);
    const cfg = join(tmpDir, 'k.agent.md');
    writeFileSync(
      cfg,
      '---\nid: k\nworkdir: /tmp/k\nactions:\n  - key: repo.review\n---\n## Mission\nm\n',
    );
    const db = openDb(join(tmpDir, 'lantern.db'));
    upsertAgentFromConfig(db, loadAgentConfig(cfg), cfg);
    const pulseId = createRunningPulse(db, {
      agentId: 'k',
      windowStart: '2026-09-07T00:00:00.000Z',
      windowEnd: '2026-09-08T00:00:00.000Z',
    });
    const ctx = {
      lanternDir: tmpDir,
      agentId: 'k',
      pulseId,
      sessionId: null,
      ticketId: null,
      tier: 'orchestrator' as const,
    };
    const record = (action_key: string) =>
      callToolDirect(db, ctx, { actor: 'test' }, 'pulse_finding', { action_key, outcome: 'clean' });

    assert.equal(record('repo.review').isError, undefined, 'a configured action');
    assert.equal(record('Staff.Work').isError, undefined, 'an alias');
    assert.match(
      String(record('staff.ticket').content[0]?.text),
      /already recorded/,
      'same action',
    );
    const bad = record('tickets.tidy');
    assert.equal(bad.isError, true);
    assert.match(String(bad.content[0]?.text), /repo\.review, logs\.scan, .*staffing/);

    const keys = db
      .prepare('SELECT action_key FROM pulse_findings WHERE pulse_id = ? ORDER BY id')
      .all(pulseId)
      .map((r) => (r as { action_key: string }).action_key);
    db.close();
    assert.deepEqual(keys, ['repo.review', 'staffing']);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
