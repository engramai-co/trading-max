-- Add assistant providers without changing existing connections.
CREATE TABLE integration_settings_v7 (
    integration_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('trading212', 'deepseek', 'openai', 'opencode', 'alpaca', 'anthropic', 'google', 'openai-codex', 'eodhd', 'openrouter', 'ollama', 'lmstudio')),
    profile TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    model TEXT,
    base_url TEXT,
    credential_ref TEXT,
    credential_fingerprint TEXT,
    last_test_at TEXT,
    last_test_status TEXT CHECK (last_test_status IN ('succeeded', 'failed', 'untested')),
    last_error_code TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    UNIQUE(provider, profile)
);

INSERT INTO integration_settings_v7 (
    integration_id, provider, profile, enabled, model, base_url,
    credential_ref, credential_fingerprint, last_test_at,
    last_test_status, last_error_code, revision, updated_at
)
SELECT
    integration_id, provider, profile, enabled, model, base_url,
    credential_ref, credential_fingerprint, last_test_at,
    last_test_status, last_error_code, revision, updated_at
FROM integration_settings;

DROP TABLE integration_settings;

ALTER TABLE integration_settings_v7 RENAME TO integration_settings;

CREATE TABLE assistant_preferences (
    preference_id TEXT PRIMARY KEY CHECK (preference_id = 'local'),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    route TEXT,
    reasoning TEXT CHECK (reasoning IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
    accepted_consent_revision INTEGER CHECK (accepted_consent_revision >= 1),
    accepted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    CHECK ((accepted_at IS NULL) = (accepted_consent_revision IS NULL)),
    CHECK (enabled = 0 OR (route IS NOT NULL AND accepted_consent_revision IS NOT NULL))
);

INSERT INTO assistant_preferences (preference_id, updated_at)
VALUES ('local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
