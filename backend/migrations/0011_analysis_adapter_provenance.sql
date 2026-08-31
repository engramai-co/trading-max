ALTER TABLE analysis_runs
    ADD COLUMN adapter TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE analysis_runs
    ADD COLUMN provider_revision INTEGER;
