ALTER TABLE analysis_runs
    ADD COLUMN route TEXT NOT NULL DEFAULT 'fake/trading-max-fake-v1';

ALTER TABLE analysis_runs
    ADD COLUMN route_policy_revision INTEGER;
