from __future__ import annotations

from pathlib import Path

import pytest

from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import (
    CredentialStoreError,
    InMemoryCredentialStore,
)
from services.api.trading_max_api.provider_runtime import (
    ProviderRuntimeError,
    make_provider_factory,
)
from services.api.trading_max_api.settings import SettingsRepository


def _settings(root: Path, *, provider: str) -> Settings:
    return Settings(
        data_root=root,
        llm_provider=provider,
        embedded_worker=True,
    )


class _UnavailableCredentialStore:
    def get(self, reference: str) -> str | None:
        raise CredentialStoreError("credential backend unavailable")

    def put(self, reference: str, secret: str) -> None:
        raise CredentialStoreError("credential backend unavailable")

    def delete(self, reference: str) -> None:
        raise CredentialStoreError("credential backend unavailable")


def test_missing_native_credential_backend_does_not_break_fake_bootstrap(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    try:
        factory = make_provider_factory(
            _settings(tmp_path, provider="fake"),
            preferences,
            _UnavailableCredentialStore(),
        )
        provider = factory()
        assert provider.name == "fake"
        assert provider.route_id == "fake/trading-max-fake-v1"
    finally:
        preferences.close()


def test_missing_native_credential_backend_fails_strictly_at_admission(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    try:
        factory = make_provider_factory(
            _settings(tmp_path, provider="opencode"),
            preferences,
            _UnavailableCredentialStore(),
        )
        with pytest.raises(ProviderRuntimeError) as error:
            factory("portfolio")
        assert error.value.code == "credential_store_unavailable"
    finally:
        preferences.close()


def test_strict_route_resolution_fails_at_analysis_admission_without_a_key(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    try:
        factory = make_provider_factory(
            _settings(tmp_path, provider="opencode"),
            preferences,
            InMemoryCredentialStore(),
        )
        with pytest.raises(ProviderRuntimeError) as error:
            factory("portfolio")
        assert error.value.code == "provider_not_configured"
        assert "secret" not in str(error.value).lower()
    finally:
        preferences.close()


def test_fake_route_is_explicitly_recorded_as_fake(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    try:
        factory = make_provider_factory(
            _settings(tmp_path, provider="fake"),
            preferences,
            InMemoryCredentialStore(),
        )
        provider = factory("portfolio")
        assert provider.name == "fake"
        assert provider.route_id == "fake/trading-max-fake-v1"
        assert provider.adapter == "fake"
        assert provider.route_policy_revision == 1
    finally:
        preferences.close()


def test_runtime_falls_back_to_the_only_configured_approved_provider(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    credentials = InMemoryCredentialStore()
    try:
        preferences.save_integration(
            provider="deepseek",
            profile=None,
            enabled=True,
            model="deepseek-v4-flash",
            base_url="https://api.deepseek.com",
            credential_fingerprint="configured",
            test_status="succeeded",
        )
        credentials.put("deepseek:default", "direct-key")
        factory = make_provider_factory(
            _settings(tmp_path, provider="opencode"),
            preferences,
            credentials,
        )

        provider = factory("taxonomy")

        assert provider.name == "deepseek"
        assert provider.route_id == "deepseek/deepseek-v4-flash"
        assert provider.provider_revision == 1
    finally:
        preferences.close()


def test_runtime_keeps_the_preferred_route_when_it_is_configured(
    tmp_path: Path,
) -> None:
    preferences = SettingsRepository(tmp_path)
    credentials = InMemoryCredentialStore(
        {
            "opencode:default": "preferred-key",
            "deepseek:default": "fallback-key",
        }
    )
    try:
        factory = make_provider_factory(
            _settings(tmp_path, provider="opencode"),
            preferences,
            credentials,
        )

        provider = factory("taxonomy")

        assert provider.name == "opencode"
        assert provider.route_id == "opencode/deepseek-v4-flash"
    finally:
        preferences.close()
