CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('starting', 'idle', 'running', 'stopping', 'stopped')),
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    current_job_id TEXT,
    worker_version TEXT NOT NULL,
    pid INTEGER,
    host TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last_seen
    ON worker_heartbeats(last_seen_at);
