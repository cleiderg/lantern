-- ci.watch: the history a flaky test is
-- seen in. A run is one execution of the agent's test command on one commit;
-- its results are one row per test. observations holds failures only, which
-- cannot tell a flaky test (pass and fail on one commit) from a broken one.
CREATE TABLE ci_runs (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  pulse_id    INTEGER REFERENCES pulses(id),
  commit_sha  TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  -- passed: every test passed or skipped · failed: some failed or errored ·
  -- broken: the command failed and wrote no report · timeout: killed at the deadline
  status      TEXT NOT NULL CHECK (status IN ('passed','failed','broken','timeout')),
  exit_code   INTEGER,
  tests       INTEGER NOT NULL DEFAULT 0,
  detail      TEXT
);
CREATE INDEX idx_ci_runs_agent ON ci_runs(agent_id, started_at);

CREATE TABLE test_results (
  run_id   INTEGER NOT NULL REFERENCES ci_runs(id),
  test_id  TEXT NOT NULL,                       -- classname#name
  outcome  TEXT NOT NULL CHECK (outcome IN ('pass','fail','error','skip')),
  flaky    INTEGER NOT NULL DEFAULT 0,          -- passed only after a rerun
  ms       INTEGER NOT NULL DEFAULT 0,
  message  TEXT,                                -- collected content (Law 8)
  PRIMARY KEY (run_id, test_id)
);
CREATE INDEX idx_test_results_test ON test_results(test_id);
