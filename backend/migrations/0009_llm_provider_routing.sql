-- Provider destinations and model allowlists are application-owned.  SQLite
-- cannot alter a CHECK constraint in place, so rebuild the metadata table
-- while preserving existing Trading 212, DeepSeek, and legacy OpenAI rows.
CREATE TABLE integration_settings_v2 (
    integration_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('trading212', 'deepseek', 'openai', 'opencode')),
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

INSERT INTO integration_settings_v2 (
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

ALTER TABLE integration_settings_v2 RENAME TO integration_settings;

CREATE TABLE llm_route_policy (
    policy_id TEXT PRIMARY KEY CHECK (policy_id = 'active'),
    default_route TEXT NOT NULL,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO llm_route_policy (
    policy_id, default_route, overrides_json, revision, updated_at
)
VALUES (
    'active',
    'opencode/deepseek-v4-flash',
    '{}',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
