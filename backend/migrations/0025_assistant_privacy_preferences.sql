ALTER TABLE assistant_preferences ADD COLUMN background_briefs_enabled INTEGER NOT NULL
    DEFAULT 1 CHECK (background_briefs_enabled IN (0, 1));
ALTER TABLE assistant_preferences ADD COLUMN share_valuation_assumptions INTEGER NOT NULL
    DEFAULT 1 CHECK (share_valuation_assumptions IN (0, 1));

-- The new disclosure includes background writing and saved valuation assumptions.
UPDATE assistant_preferences SET enabled = 0, accepted_consent_revision = NULL,
    accepted_at = NULL, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE accepted_consent_revision IS NOT NULL;
