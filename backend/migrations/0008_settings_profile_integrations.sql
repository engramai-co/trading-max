CREATE TABLE IF NOT EXISTS user_profile (
    profile_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    initials TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    locale TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
    base_currency TEXT NOT NULL,
    timezone TEXT NOT NULL,
    account_labels_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_settings (
    integration_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('trading212', 'deepseek', 'openai')),
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

CREATE TABLE IF NOT EXISTS settings_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    integration_id TEXT,
    revision INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

INSERT OR IGNORE INTO user_profile (
    profile_id, display_name, initials, avatar_color, locale,
    base_currency, timezone, account_labels_json, revision, updated_at
) VALUES (
    'local', 'Investor', 'TM', '#2563EB', 'zh',
    'GBP', 'Europe/London', '{"A":"Invest","B":"Stocks ISA","C":"Historical CFD"}',
    1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
