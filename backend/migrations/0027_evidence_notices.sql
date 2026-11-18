-- Notices of new evidence for saved valuation versions stay off until chosen.
ALTER TABLE automation_preferences
    ADD COLUMN evidence_notices_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (evidence_notices_enabled IN (0, 1));
