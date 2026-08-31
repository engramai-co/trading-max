ALTER TABLE job_stages RENAME TO job_stages_before_three_scope;
ALTER TABLE job_events RENAME TO job_events_before_three_scope;
CREATE TABLE job_stages_three_scope_data AS SELECT * FROM job_stages_before_three_scope;
CREATE TABLE job_events_three_scope_data AS SELECT * FROM job_events_before_three_scope;

ALTER TABLE jobs RENAME TO jobs_before_three_scope;
CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN (
        'all', 'accounts', 'research', 'intraday', 'cfd', 'live', 'performance'
    )),
    trigger TEXT NOT NULL CHECK (trigger IN (
        'on_demand', 'nightly', 'intraday', 'live', 'performance',
        'research', 'reconciliation', 'system'
    )),
    skip_sync INTEGER NOT NULL DEFAULT 0 CHECK (skip_sync IN (0, 1)),
    tickers_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'interrupted'
    )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    lease_expires_at TEXT,
    worker_id TEXT,
    snapshot_run_id TEXT,
    error_code TEXT,
    error_message TEXT,
    scheduled_for TEXT,
    log_path TEXT,
    follow_up_research INTEGER NOT NULL DEFAULT 0 CHECK (follow_up_research IN (0, 1)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
);
INSERT INTO jobs SELECT * FROM jobs_before_three_scope;
DROP TABLE jobs_before_three_scope;

CREATE TABLE job_stages (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted'
    )),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    started_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    error_message TEXT,
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    label TEXT NOT NULL DEFAULT '',
    return_code INTEGER,
    idempotency_key TEXT,
    PRIMARY KEY (job_id, name)
);
INSERT INTO job_stages SELECT * FROM job_stages_three_scope_data;
DROP TABLE job_stages_before_three_scope;
DROP TABLE job_stages_three_scope_data;

CREATE TABLE job_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO job_events SELECT * FROM job_events_three_scope_data;
DROP TABLE job_events_before_three_scope;
DROP TABLE job_events_three_scope_data;

CREATE INDEX IF NOT EXISTS idx_jobs_claim
    ON jobs(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events(job_id, event_id);
