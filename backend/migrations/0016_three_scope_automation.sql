ALTER TABLE automation_preferences
    ADD COLUMN live_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (live_enabled IN (0, 1));
ALTER TABLE automation_preferences
    ADD COLUMN performance_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (performance_enabled IN (0, 1));
ALTER TABLE automation_preferences
    ADD COLUMN research_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (research_enabled IN (0, 1));

UPDATE automation_preferences
SET live_enabled = intraday_enabled,
    performance_enabled = nightly_enabled,
    research_enabled = nightly_enabled;
