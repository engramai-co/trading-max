CREATE TABLE IF NOT EXISTS stage_cache (
    idempotency_key TEXT PRIMARY KEY,
    stage_name TEXT NOT NULL,
    stage_version TEXT NOT NULL,
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

ALTER TABLE job_stages ADD COLUMN idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_stage_cache_lookup
    ON stage_cache(stage_name, stage_version, last_used_at);
