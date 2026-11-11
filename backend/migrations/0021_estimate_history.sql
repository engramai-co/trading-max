CREATE TABLE research_estimate_history (
    id INTEGER PRIMARY KEY,
    ticker TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    observation_json TEXT NOT NULL
);

CREATE INDEX idx_research_estimate_history_ticker_time
    ON research_estimate_history(ticker, observed_at DESC, id DESC);

CREATE TABLE research_estimate_recovery (
    id INTEGER PRIMARY KEY CHECK (id = 1)
);
