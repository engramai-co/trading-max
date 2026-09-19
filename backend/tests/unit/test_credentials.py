from __future__ import annotations

import json
import subprocess
import sys
from types import SimpleNamespace

import pytest
from trading_max.credentials import DEFAULT_CREDENTIAL_SERVICE, legacy_credential_lookup_enabled
from trading_max.ingestion.brokers import trading212

from services.api.trading_max_api import credentials as api_credentials


@pytest.mark.parametrize("enabled", ["true", "1", "yes", "on", "false"])
def test_isolated_namespace_cannot_enable_legacy_lookup(enabled: str) -> None:
    assert not legacy_credential_lookup_enabled(
        {
            "TRADING_MAX_CREDENTIAL_SERVICE": f"{DEFAULT_CREDENTIAL_SERVICE}.isolated",
            "TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP": enabled,
        }
    )


@pytest.mark.parametrize(("enabled", "expected"), [(None, True), ("true", True), ("false", False)])
def test_default_namespace_preserves_legacy_migration_compatibility(
    enabled: str | None,
    expected: bool,
) -> None:
    environment = {"TRADING_MAX_CREDENTIAL_SERVICE": DEFAULT_CREDENTIAL_SERVICE}
    if enabled is not None:
        environment["TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP"] = enabled
    assert legacy_credential_lookup_enabled(environment) is expected


def test_custom_installation_queries_only_its_own_fake_keyring_even_when_legacy_is_enabled(
    monkeypatch,
) -> None:
    service = f"{DEFAULT_CREDENTIAL_SERVICE}.isolated"
    calls: list[tuple[str, str]] = []

    def lookup(requested_service: str, reference: str) -> str | None:
        calls.append((requested_service, reference))
        if requested_service != service:
            return json.dumps({"api_key": "other-installation", "api_secret": "synthetic"})
        return None

    def fake_security(arguments: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        calls.append((arguments[arguments.index("-s") + 1], arguments[arguments.index("-a") + 1]))
        return subprocess.CompletedProcess(arguments, 44, "", "item not found")

    monkeypatch.setenv("TRADING_MAX_CREDENTIAL_SERVICE", service)
    monkeypatch.setenv("TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP", "true")
    monkeypatch.setitem(sys.modules, "keyring", SimpleNamespace(get_password=lookup))
    monkeypatch.setattr(trading212.subprocess, "run", fake_security)

    assert api_credentials.default_credential_store().get("deepseek:default") is None
    assert trading212._keychain_credentials("invest") is None
    assert calls
    assert all(requested_service == service for requested_service, _reference in calls)


def test_custom_installation_does_not_inherit_ambient_broker_secrets_when_legacy_is_enabled(
    monkeypatch,
) -> None:
    monkeypatch.setenv("TRADING_MAX_CREDENTIAL_SERVICE", f"{DEFAULT_CREDENTIAL_SERVICE}.isolated")
    monkeypatch.setenv("TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP", "true")
    monkeypatch.setenv("T212_INVEST_API_KEY", "other-installation")
    monkeypatch.setenv("T212_INVEST_API_SECRET", "synthetic")
    monkeypatch.setattr(trading212, "_keychain_credentials", lambda _profile: None)

    with pytest.raises(trading212.Trading212CredentialsError, match="missing credentials"):
        trading212.Trading212Credentials.from_sources("invest")


def test_default_installation_can_still_query_legacy_fake_keyring(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    def lookup(service: str, reference: str) -> str | None:
        calls.append((service, reference))
        return "synthetic-legacy-secret" if service == "com.engram.trading-max.deepseek" else None

    monkeypatch.setenv("TRADING_MAX_CREDENTIAL_SERVICE", DEFAULT_CREDENTIAL_SERVICE)
    monkeypatch.setenv("TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP", "true")
    monkeypatch.setitem(sys.modules, "keyring", SimpleNamespace(get_password=lookup))

    assert (
        api_credentials.default_credential_store().get("deepseek:default")
        == "synthetic-legacy-secret"
    )
    assert calls == [
        (DEFAULT_CREDENTIAL_SERVICE, "deepseek:default"),
        ("com.engram.trading-max.deepseek", "trading-max-api"),
    ]
