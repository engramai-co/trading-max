CREATE TABLE IF NOT EXISTS automation_preferences (
    preference_id TEXT PRIMARY KEY CHECK (preference_id = 'local'),
    nightly_enabled INTEGER NOT NULL CHECK (nightly_enabled IN (0, 1)),
    intraday_enabled INTEGER NOT NULL CHECK (intraday_enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL
);
