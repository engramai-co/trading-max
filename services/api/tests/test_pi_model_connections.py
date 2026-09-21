from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from trading_max.infrastructure import SqliteDatabase

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.llm_routing import DEFAULT_ROUTE, provider_spec
from services.api.trading_max_api.provider_runtime import make_provider_factory
from services.api.trading_max_api.settings import MIGRATIONS, SettingsRepository


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google"])
def test_provider_choice_is_tested_saved_and_used_for_all_default_workloads(
    tmp_path, monkeypatch, provider
):
    spec = provider_spec(provider)
    credentials = InMemoryCredentialStore()
    settings = Settings(data_root=tmp_path, llm_provider="openai", api_token="fixture-token")
    calls = []

    def check(**kwargs):
        calls.append(kwargs)
        return "verified"

    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings._check_openai_compatible_connection", check
    )
    with TestClient(create_app(settings, credential_store=credentials)) as client:
        headers = {"Authorization": "Bearer fixture-token"}
        path = f"/v1/settings/llm/providers/{provider}"
        candidate = {"apiKey": "synthetic-key", "model": spec.default_model}
        tested = client.post(path + "/test", json=candidate, headers=headers)
        assert tested.status_code == 200
        assert credentials.get(spec.credential_ref) is None
        saved = client.put(
            path,
            json={
                **candidate,
                "validationToken": tested.json()["validationToken"],
                "useAsDefault": True,
            },
            headers=headers,
        )
        assert saved.status_code == 200
        assert "synthetic-key" not in saved.text
        assert calls[0]["base_url"] == spec.base_url
        preferences = SettingsRepository(tmp_path)
        try:
            assert (
                preferences.get_route_policy().default_route == f"{provider}/{spec.default_model}"
            )
            factory = make_provider_factory(settings, preferences, credentials)
            for workload in ("portfolio", "ticker", "taxonomy"):
                actual = factory(workload)
                assert actual.name == provider
                assert actual.model == spec.default_model
                assert actual.adapter == "pi-ai"
        finally:
            preferences.close()


def test_legacy_migration_keeps_metadata_and_is_idempotent(tmp_path: Path):
    old = tmp_path / "old-migrations"
    old.mkdir()
    for path in MIGRATIONS.glob("*.sql"):
        if path.name < "0019":
            shutil.copyfile(path, old / path.name)
    root = tmp_path / "state"
    database = SqliteDatabase(root / "trading_max.db", migrations_dir=old)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE llm_route_policy SET overrides_json = ?",
            ('{"ticker":"deepseek/deepseek-chat","taxonomy":"anthropic/claude-sonnet-4-6"}',),
        )
        connection.execute("""INSERT INTO integration_settings
            (integration_id, provider, enabled, credential_ref, credential_fingerprint, updated_at)
            VALUES ('deepseek:default', 'deepseek', 1, 'deepseek:default', 'fixture-fingerprint', '2026-09-20T00:00:00Z')""")
    database.close()
    preferences = SettingsRepository(root)
    policy = preferences.get_route_policy()
    assert policy.default_route == DEFAULT_ROUTE
    assert policy.overrides == {"taxonomy": "anthropic/claude-sonnet-4-6"}
    legacy = preferences.get_integration("deepseek")
    assert legacy and not legacy.enabled and legacy.credential_fingerprint == "fixture-fingerprint"
    preferences.close()
    reopened = SettingsRepository(root)
    try:
        assert reopened.get_route_policy() == policy
    finally:
        reopened.close()
