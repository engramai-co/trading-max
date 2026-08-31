ALTER TABLE analysis_runs
    ADD COLUMN lenses_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS analysis_latest_lens (
    snapshot_run_id TEXT NOT NULL,
    lens TEXT NOT NULL,
    ticker TEXT NOT NULL DEFAULT 'PORTFOLIO',
    artifact_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (snapshot_run_id, lens, ticker)
);

CREATE INDEX IF NOT EXISTS idx_analysis_latest_lens_artifact
    ON analysis_latest_lens(artifact_id);

INSERT OR IGNORE INTO analysis_latest_lens (
    snapshot_run_id,
    lens,
    ticker,
    artifact_id,
    input_hash,
    updated_at
)
SELECT
    snapshot_run_id,
    CASE page
        WHEN 'overview' THEN 'daily_cio_brief'
        WHEN 'holdings' THEN 'hidden_exposure'
        WHEN 'analytics' THEN 'return_attribution'
        WHEN 'research' THEN 'watchlist_opportunity_map'
        WHEN 'technical' THEN 'technical_regime'
        WHEN 'valuation' THEN 'valuation_scenario'
        WHEN 'fundamentals' THEN 'fundamental_health'
        WHEN 'analyst' THEN 'analyst_consensus'
        WHEN 'financials' THEN 'financial_statements'
        WHEN 'options' THEN 'options_positioning'
        WHEN 'ledger' THEN 'thesis_change'
        ELSE page
    END,
    ticker,
    artifact_id,
    input_hash,
    updated_at
FROM analysis_latest;
