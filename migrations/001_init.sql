-- Migration 001: full initial schema
--
-- Worth knowing:
--   ticket_files(ticket_id, path) — indexed projection for prior-art file-overlap boost
--   observations.last_pulse_id   — tracks which pulse last saw a fingerprint so
--                                   pulse_count only increments per distinct pulse
--   sessions.id                  — TEXT (local uuid); the harness's own session id is not stored
--
-- Table order chosen to satisfy FK references at insert time with foreign_keys=ON.
-- (SQLite validates FKs on insert/update, not on CREATE TABLE, so no DDL deferral needed.)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Orchestrators ────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id                TEXT PRIMARY KEY,          -- 'lloyd'
  display_name      TEXT NOT NULL,
  config_path       TEXT NOT NULL,             -- agents/lloyd.agent.md
  mission           TEXT NOT NULL,
  heartbeat_seconds INTEGER NOT NULL DEFAULT 3600,
  max_children      INTEGER NOT NULL DEFAULT 4,
  state             TEXT NOT NULL DEFAULT 'paused'
                    CHECK (state IN ('running','paused','stopped','tripped')),
  workdir           TEXT NOT NULL,
  paused_reason     TEXT,
  last_pulse_at     TEXT,
  next_pulse_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Pulses: the audit trail ──────────────────────────────────────────────────
CREATE TABLE pulses (
  id            INTEGER PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  window_start  TEXT NOT NULL,                 -- observation window covered by this pulse
  window_end    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','clean','acted','escalated','error','skipped')),
  summary       TEXT,                          -- one paragraph, human-readable
  cost_usd      REAL DEFAULT 0,
  duration_ms   INTEGER,
  session_id    TEXT,                          -- harness session id for the orchestrator turn
  error         TEXT
);
CREATE INDEX idx_pulses_agent ON pulses(agent_id, started_at DESC);

-- ─── Sessions: the fleet ──────────────────────────────────────────────────────
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,               -- local uuid
  agent_id     TEXT REFERENCES agents(id),
  parent_id    TEXT REFERENCES sessions(id),
  pulse_id     INTEGER REFERENCES pulses(id),
  ticket_id    INTEGER REFERENCES tickets(id),
  label        TEXT,                           -- '729-retry-backoff'
  tier         TEXT NOT NULL CHECK (tier IN ('read_only','write_branch','release')),
  harness      TEXT NOT NULL DEFAULT 'claude-code',
  model        TEXT,
  worktree     TEXT,
  branch       TEXT,
  status       TEXT NOT NULL DEFAULT 'starting'
               CHECK (status IN ('starting','running','waiting','done','failed','killed','timeout')),
  cost_usd     REAL DEFAULT 0,
  num_turns    INTEGER,
  exit_code    INTEGER,
  result       TEXT,
  transcript_path TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);
CREATE INDEX idx_sessions_live ON sessions(status) WHERE status IN ('starting','running','waiting');

-- ─── Tickets: the memory ──────────────────────────────────────────────────────
CREATE TABLE tickets (
  id            INTEGER PRIMARY KEY,           -- human-facing #729
  agent_id      TEXT REFERENCES agents(id),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('bug','enhancement','chore','docs','investigation','release','question')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,                 -- markdown
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                  ('open','triage','staffed','in_review','blocked','closed','wontfix','duplicate')),
  priority      TEXT NOT NULL DEFAULT 'p3' CHECK (priority IN ('p0','p1','p2','p3')),
  origin        TEXT NOT NULL CHECK (origin IN
                  ('human','collector:email','collector:logs','collector:docs',
                   'collector:ci','agent:self','agent:child')),
  origin_ref    TEXT,                          -- message-id, log fingerprint, PR url
  fingerprint   TEXT,                          -- dedupe key (noise suppression)
  needs_triage  INTEGER NOT NULL DEFAULT 0,    -- the agent's "voice": flagged for the human
  repo          TEXT,
  branch        TEXT,
  pr_url        TEXT,
  resolution    TEXT,                          -- free text written at close; feeds prior-art search
  opened_pulse  INTEGER REFERENCES pulses(id),
  closed_pulse  INTEGER REFERENCES pulses(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);
CREATE INDEX idx_tickets_status      ON tickets(status, priority);
CREATE INDEX idx_tickets_fingerprint ON tickets(fingerprint);
CREATE INDEX idx_tickets_triage      ON tickets(needs_triage) WHERE needs_triage = 1;

-- Touched file projection for prior-art file-overlap boost.
-- Populated by the tool layer when a session closes; joins onto tickets for FTS re-ranking.
CREATE TABLE ticket_files (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  PRIMARY KEY (ticket_id, path)
);
CREATE INDEX idx_ticket_files_path ON ticket_files(path);

-- Typed relationships. 'relates_to' is what prior-art search writes.
CREATE TABLE ticket_links (
  from_ticket INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_ticket   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  rel         TEXT NOT NULL CHECK (rel IN
                ('duplicates','relates_to','caused_by','blocks','supersedes')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_ticket, to_ticket, rel)
);

-- Append-only. Never UPDATE a ticket without writing one of these.
CREATE TABLE ticket_events (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  pulse_id   INTEGER REFERENCES pulses(id),
  session_id TEXT REFERENCES sessions(id),
  actor      TEXT NOT NULL,                    -- 'human' | 'lloyd' | 'child:495-docs'
  event      TEXT NOT NULL,                    -- 'created','staffed','commented','status_changed',...
  payload    TEXT,                             -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_ticket ON ticket_events(ticket_id, created_at);

-- ─── One row per every-pulse action, per pulse ────────────────────────────────
CREATE TABLE pulse_findings (
  id         INTEGER PRIMARY KEY,
  pulse_id   INTEGER NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL,                    -- 'logs.scan', 'inbox.check', 'docs.drift'
  outcome    TEXT NOT NULL CHECK (outcome IN ('clean','finding','skipped','error')),
  detail     TEXT,
  ticket_id  INTEGER REFERENCES tickets(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Escalations: the human queue ─────────────────────────────────────────────
CREATE TABLE escalations (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  pulse_id    INTEGER REFERENCES pulses(id),
  ticket_id   INTEGER REFERENCES tickets(id),
  severity    TEXT NOT NULL CHECK (severity IN ('fyi','decide','blocking')),
  question    TEXT NOT NULL,
  context     TEXT,                            -- JSON: links, diffs, log excerpts
  options     TEXT,                            -- JSON array of proposed choices
  answer      TEXT,
  answered_by TEXT,
  answered_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Noise suppression ────────────────────────────────────────────────────────
-- last_pulse_id makes pulse_count increment once per distinct pulse.
CREATE TABLE observations (
  fingerprint     TEXT PRIMARY KEY,
  source          TEXT NOT NULL,               -- 'logs','email','ci'
  sample          TEXT NOT NULL,               -- representative raw text
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  occurrences     INTEGER NOT NULL DEFAULT 1,
  pulse_count     INTEGER NOT NULL DEFAULT 1,  -- distinct pulses that saw it
  last_pulse_id   INTEGER REFERENCES pulses(id),
  ticket_id       INTEGER REFERENCES tickets(id),
  suppressed      INTEGER NOT NULL DEFAULT 0,
  suppress_until  TEXT,
  suppress_reason TEXT
);

-- ─── Playbooks ────────────────────────────────────────────────────────────────
CREATE TABLE playbooks (
  key         TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE playbook_runs (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL REFERENCES playbooks(key),
  pulse_id    INTEGER REFERENCES pulses(id),
  status      TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  stdout_path TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT
);

-- ─── Spend ────────────────────────────────────────────────────────────────────
CREATE TABLE usage_daily (
  day        TEXT PRIMARY KEY,                 -- 'YYYY-MM-DD'
  cost_usd   REAL NOT NULL DEFAULT 0,
  pulses     INTEGER NOT NULL DEFAULT 0,
  sessions   INTEGER NOT NULL DEFAULT 0
);

-- ─── Prior-art search ─────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  title, body, resolution,
  content='tickets', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER tickets_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, title, body, resolution)
  VALUES (new.id, new.title, new.body, coalesce(new.resolution,''));
END;
CREATE TRIGGER tickets_ad AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, body, resolution)
  VALUES ('delete', old.id, old.title, old.body, coalesce(old.resolution,''));
END;
CREATE TRIGGER tickets_au AFTER UPDATE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, body, resolution)
  VALUES ('delete', old.id, old.title, old.body, coalesce(old.resolution,''));
  INSERT INTO tickets_fts(rowid, title, body, resolution)
  VALUES (new.id, new.title, new.body, coalesce(new.resolution,''));
END;
