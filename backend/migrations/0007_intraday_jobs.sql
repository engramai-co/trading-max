-- Extend the durable job queue without losing existing jobs or stage events.
-- SQLite CHECK constraints are immutable, so rebuild the three tables that
-- reference the jobs table while preserving every existing column and row.
ALTER TABLE job_stages RENAME TO job_stages_before_intraday;
ALTER TABLE job_events RENAME TO job_events_before_intraday;
CREATE TABLE job_stages_intraday_data AS
SELECT * FROM job_stages_before_intraday;
CREATE TABLE job_events_intraday_data AS
SELECT * FROM job_events_before_intraday;

CREATE TABLE jobs_before_intraday (
    job_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('all', 'accounts', 'research', 'intraday')),
    trigger TEXT NOT NULL CHECK (trigger IN ('on_demand', 'nightly', 'intraday', 'system')),
    skip_sync INTEGER NOT NULL DEFAULT 0 CHECK (skip_sync IN (0, 1)),
    tickers_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
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

INSERT INTO jobs_before_intraday(
    job_id, scope, trigger, skip_sync, tickers_json, status, attempts,
    created_at, started_at, finished_at, lease_expires_at, worker_id,
    snapshot_run_id, error_code, error_message, scheduled_for, log_path,
    follow_up_research, cancel_requested
)
SELECT
    job_id, scope, trigger, skip_sync, tickers_json, status, attempts,
    created_at, started_at, finished_at, lease_expires_at, worker_id,
    snapshot_run_id, error_code, error_message, scheduled_for, log_path,
    follow_up_research, cancel_requested
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_before_intraday RENAME TO jobs;

CREATE TABLE job_stages (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted')),
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

INSERT INTO job_stages(
    job_id, name, version, status, attempt, started_at, finished_at,
    error_code, error_message, artifact_ids_json, label, return_code,
    idempotency_key
)
SELECT
    job_id, name, version, status, attempt, started_at, finished_at,
    error_code, error_message, artifact_ids_json, label, return_code,
    idempotency_key
FROM job_stages_intraday_data;

DROP TABLE job_stages_before_intraday;

CREATE TABLE job_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO job_events(event_id, job_id, created_at, event_type, payload_json)
SELECT event_id, job_id, created_at, event_type, payload_json
FROM job_events_intraday_data;

DROP TABLE job_events_before_intraday;
DROP TABLE job_stages_intraday_data;
DROP TABLE job_events_intraday_data;

CREATE INDEX IF NOT EXISTS idx_jobs_claim
    ON jobs(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_job_events_job
    ON job_events(job_id, event_id);
