CREATE TABLE pending_account_check (
    account_code TEXT PRIMARY KEY,
    observed_at TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    request_job_id TEXT,
    request_attempts INTEGER NOT NULL DEFAULT 0,
    retry_after TEXT
);
