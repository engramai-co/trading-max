UPDATE user_profile
SET
    account_labels_json = json_set(account_labels_json, '$.C', 'CFD'),
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_extract(account_labels_json, '$.C') IN (
    'Historical CFD',
    'Historical CFD (closed)',
    'CFD · 已停用'
);
