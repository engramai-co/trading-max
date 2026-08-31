from __future__ import annotations

from services.api.trading_max_api import credentials


class _StubKeyringCredentialStore:
    def __init__(self, *, service: str) -> None:
        self.service = service

    def get(self, reference: str) -> str | None:
        del reference
        return None

    def put(self, reference: str, secret: str) -> None:
        del reference, secret

    def delete(self, reference: str) -> None:
        del reference


def test_isolated_namespace_does_not_construct_a_legacy_store(monkeypatch) -> None:
    service = "com.engram.trading-max.credentials.install-b"
    monkeypatch.setenv("TRADING_MAX_CREDENTIAL_SERVICE", service)
    monkeypatch.setattr(credentials, "KeyringCredentialStore", _StubKeyringCredentialStore)

    store = credentials.default_credential_store()

    assert isinstance(store, _StubKeyringCredentialStore)
    assert store.service == service


def test_historical_default_namespace_keeps_explicit_migration_adapter(monkeypatch) -> None:
    monkeypatch.delenv("TRADING_MAX_CREDENTIAL_SERVICE", raising=False)
    monkeypatch.delenv("TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP", raising=False)
    monkeypatch.setattr(credentials, "KeyringCredentialStore", _StubKeyringCredentialStore)

    store = credentials.default_credential_store()

    assert isinstance(store, credentials.LegacyAwareCredentialStore)
    assert store.primary.service == "com.engram.trading-max.credentials"
    assert store.legacy_deepseek.service == "com.engram.trading-max.deepseek"
