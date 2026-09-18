from __future__ import annotations

import json

from fastapi.testclient import TestClient
from trading_max.analytics.alpaca_prices import (
    AlpacaDataError,
    AlpacaEnhancedPriceLoader,
    AlpacaHistoricalClient,
)
from trading_max.analytics.intraday_reconstruction import CachedIntradayPriceLoader

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.market_data_runtime import reconstruction_loader_factory

PATH = "/v1/settings/integrations/alpaca"
AUTH = {"Authorization": "Bearer fixture-token"}
CANDIDATE = {"apiKeyId": "synthetic-key", "secretKey": "synthetic-secret"}


def test_test_save_toggle_remove_and_runtime_credentials(tmp_path, monkeypatch):
    tested = []
    monkeypatch.setattr(AlpacaHistoricalClient, "test", lambda self: tested.append(True))
    keys = InMemoryCredentialStore()
    app = create_app(Settings(data_root=tmp_path, api_token="fixture-token"), credential_store=keys)
    preferences = app.state.settings_repository
    factory = reconstruction_loader_factory(tmp_path, preferences, keys)
    with TestClient(app) as client:
        assert type(factory()) is CachedIntradayPriceLoader
        overview = client.get("/v1/settings/integrations").json()
        default = next(x for x in overview["integrations"] if x["provider"] == "alpaca")
        assert not default["enabled"] and not default["configured"]
        assert client.post(PATH + "/test", json=CANDIDATE).status_code == 401
        assert (
            client.put(
                PATH, json={**CANDIDATE, "validationToken": "forged"}, headers=AUTH
            ).status_code
            == 409
        )
        result = client.post(PATH + "/test", json=CANDIDATE, headers=AUTH)
        assert result.status_code == 200
        token = result.json()["validationToken"]
        changed = client.put(
            PATH,
            json={**CANDIDATE, "secretKey": "different", "validationToken": token},
            headers=AUTH,
        )
        assert changed.status_code == 409
        saved = client.put(PATH, json={**CANDIDATE, "validationToken": token}, headers=AUTH)
        assert saved.status_code == 200 and saved.json()["configured"]
        assert not saved.json()["enabled"]  # Saving alone never changes the default.
        assert "synthetic-secret" not in saved.text and "synthetic-key" not in saved.text
        assert json.loads(keys.get("alpaca:default"))["api_secret"] == "synthetic-secret"
        assert client.patch(PATH, json={"enabled": True}, headers=AUTH).status_code == 200
        assert isinstance(factory(), AlpacaEnhancedPriceLoader)
        last_test = preferences.get_integration("alpaca").last_test_at
        assert client.patch(PATH, json={"enabled": False}, headers=AUTH).status_code == 200
        assert preferences.get_integration("alpaca").last_test_at == last_test
        assert type(factory()) is CachedIntradayPriceLoader
        client.patch(PATH, json={"enabled": True}, headers=AUTH)
        keys.delete("alpaca:default")
        unavailable = factory()
        assert type(unavailable) is CachedIntradayPriceLoader
        assert unavailable.diagnostics["alpaca"]["status"] == "fallback"
        assert client.delete(PATH, headers=AUTH).status_code == 204
        assert not keys.get("alpaca:default") and preferences.get_integration("alpaca") is None
        assert "synthetic-secret" not in (tmp_path / "trading_max.db").read_bytes().decode(
            errors="ignore"
        )
        assert len(tested) == 3


def test_rejected_keys_and_validation_never_echo_secrets(tmp_path, monkeypatch):
    def failed(self):
        raise AlpacaDataError("Alpaca boats HTTP 403")

    monkeypatch.setattr(AlpacaHistoricalClient, "test", failed)
    app = create_app(
        Settings(data_root=tmp_path, api_token="fixture-token"),
        credential_store=InMemoryCredentialStore(),
    )
    with TestClient(app) as client:
        result = client.post(PATH + "/test", json=CANDIDATE, headers=AUTH)
        assert result.status_code == 422 and "synthetic-secret" not in result.text
        result = client.post(
            PATH + "/test", json={**CANDIDATE, "secretKey": ["synthetic-secret"]}, headers=AUTH
        )
        assert result.status_code == 422 and "synthetic-secret" not in result.text
        assert app.state.settings_repository.get_integration("alpaca") is None
