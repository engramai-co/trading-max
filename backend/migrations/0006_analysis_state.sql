CREATE TABLE IF NOT EXISTS analysis_runs (
    run_id TEXT PRIMARY KEY,
    snapshot_run_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('on_demand', 'nightly', 'snapshot')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'interrupted')),
    pages_json TEXT NOT NULL DEFAULT '[]',
    ticker TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    force INTEGER NOT NULL DEFAULT 0 CHECK (force IN (0, 1)),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    errors_json TEXT NOT NULL DEFAULT '[]',
    cached INTEGER NOT NULL DEFAULT 0 CHECK (cached IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_created
    ON analysis_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS analysis_latest (
    snapshot_run_id TEXT NOT NULL,
    page TEXT NOT NULL,
    ticker TEXT NOT NULL DEFAULT 'PORTFOLIO',
    artifact_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (snapshot_run_id, page, ticker)
);

CREATE INDEX IF NOT EXISTS idx_analysis_latest_artifact
    ON analysis_latest(artifact_id);
