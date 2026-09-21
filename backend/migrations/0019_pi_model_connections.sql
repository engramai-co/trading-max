-- Preserve historical integration metadata and credentials, retire old defaults.
CREATE TABLE integration_settings_v4 (
    integration_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('trading212', 'deepseek', 'openai', 'opencode', 'alpaca', 'anthropic', 'google')),
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

INSERT INTO integration_settings_v4 (
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

ALTER TABLE integration_settings_v4 RENAME TO integration_settings;


UPDATE llm_route_policy
SET default_route = CASE
        WHEN default_route LIKE 'opencode/%' OR default_route LIKE 'deepseek/%'
        THEN 'openai/gpt-5.4-mini' ELSE default_route END,
    overrides_json = (SELECT COALESCE(json_group_object(key, value), '{}')
        FROM json_each(llm_route_policy.overrides_json)
        WHERE value NOT LIKE 'opencode/%' AND value NOT LIKE 'deepseek/%'),
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE default_route LIKE 'opencode/%' OR default_route LIKE 'deepseek/%'
    OR EXISTS (SELECT 1 FROM json_each(llm_route_policy.overrides_json)
        WHERE value LIKE 'opencode/%' OR value LIKE 'deepseek/%');

UPDATE integration_settings
SET enabled = 0, revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE provider IN ('opencode', 'deepseek') AND enabled = 1;
