from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import (
    CredentialStoreError,
    InMemoryCredentialStore,
    KeyringCredentialStore,
)
from services.api.trading_max_api.routes import settings as settings_routes


@pytest.fixture
def boundary_client(tmp_path):
    app = create_app(
        Settings(data_root=tmp_path, api_token="test-token"),
        credential_store=InMemoryCredentialStore(),
    )
    with TestClient(app, base_url="http://127.0.0.1:8421") as client:
        client.headers["Authorization"] = "Bearer test-token"
        yield client


@pytest.mark.parametrize(
    "path,payload",
    [
        (
            "/v1/settings/integrations/trading212/invest/test",
            {"apiKeyId": "id", "secretKey": "synthetic-secret" * 100},
        ),
        (
            "/v1/settings/llm/providers/opencode/test",
            {"apiKey": "synthetic-secret" * 100, "model": "deepseek-v4-flash"},
        ),
        (
            "/v1/settings/llm/providers/deepseek",
            {"apiKey": "synthetic-secret", "validationToken": "receipt"},
        ),
    ],
)
def test_credential_validation_never_echoes_request_fields(boundary_client, path, payload):
    response = boundary_client.request(
        "PUT" if path.endswith("deepseek") else "POST", path, json=payload
    )
    assert response.status_code == 422
    assert "synthetic-secret" not in response.text
    assert all(set(error) == {"loc", "type", "msg"} for error in response.json()["detail"])


def test_malformed_llm_json_does_not_echo_credentials(boundary_client):
    response = boundary_client.post(
        "/v1/settings/llm/providers/opencode/test",
        content='{"apiKey":"synthetic-secret",',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert "synthetic-secret" not in response.text


def test_llm_provider_test_uses_production_settings_rate_limit(boundary_client, monkeypatch):
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    calls = []
    monkeypatch.setattr(
        settings_routes,
        "_check_openai_compatible_connection",
        lambda **kwargs: calls.append(True) or "synthetic success",
    )
    for _ in range(30):
        response = boundary_client.post(
            "/v1/settings/llm/providers/opencode/test",
            json={"apiKey": "synthetic-secret", "model": "deepseek-v4-flash"},
        )
        assert response.status_code == 200
    limited = boundary_client.post(
        "/v1/settings/llm/providers/opencode/test",
        json={"apiKey": "synthetic-secret", "model": "deepseek-v4-flash"},
    )
    assert limited.status_code == 429
    assert len(calls) == 30


@pytest.mark.parametrize("host", ["[::1]:8421", "localhost:8421", "LOCALHOST:8421"])
def test_production_accepts_supported_loopback_hosts(boundary_client, monkeypatch, host):
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    assert boundary_client.get("/health", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize("provider", ["trading212", "deepseek"])
def test_legacy_credential_save_returns_safe_store_failure(boundary_client, monkeypatch, provider):
    if provider == "trading212":
        path = "/v1/settings/integrations/trading212/invest"
        payload = {"apiKeyId": "synthetic-id", "secretKey": "synthetic-secret"}
        monkeypatch.setattr(settings_routes, "_test_trading212", lambda *args, **kwargs: "OK")
    else:
        path = "/v1/settings/integrations/deepseek"
        payload = {"apiKey": "synthetic-secret", "model": "deepseek-chat"}
        monkeypatch.setattr(settings_routes, "_check_deepseek_connection", lambda **kwargs: "OK")
    tested = boundary_client.post(path + "/test", json=payload)
    assert tested.status_code == 200

    def fail_store(*args):
        raise CredentialStoreError("synthetic credential store failure")

    monkeypatch.setattr(boundary_client.app.state.credential_store, "put", fail_store)
    saved = boundary_client.put(
        path, json={**payload, "validationToken": tested.json()["validationToken"]}
    )
    assert saved.status_code == 503
    assert saved.json()["detail"]["code"] == "credential_store_unavailable"
    assert "synthetic-secret" not in saved.text
    assert (
        boundary_client.app.state.settings_repository.get_integration(
            provider, "invest" if provider == "trading212" else None
        )
        is None
    )


def test_keyring_write_failure_does_not_put_secrets_in_process_arguments(monkeypatch):
    store = object.__new__(KeyringCredentialStore)
    store.service = "synthetic-service"

    def fail_write(*args):
        raise RuntimeError("synthetic keyring failure")

    store._keyring = SimpleNamespace(set_password=fail_write)
    invocations = []
    monkeypatch.setattr(store, "_security", lambda *args: invocations.append(args))
    with pytest.raises(CredentialStoreError, match="credential store is unavailable"):
        store.put("synthetic-reference", "synthetic-secret")
    assert not invocations


def test_invalid_live_refresh_returns_client_error_without_enqueuing(boundary_client):
    response = boundary_client.post("/v1/jobs/refresh", json={"scope": "live", "skipSync": True})
    assert response.status_code == 422
    assert boundary_client.app.state.jobs.list() == []


def test_unknown_job_log_returns_not_found(boundary_client):
    response = boundary_client.get("/v1/jobs/not-a-job/log")
    assert response.status_code == 404
    assert json.loads(response.text)["detail"]


def test_empty_installation_can_enable_live_schedule_without_restart(boundary_client, monkeypatch):
    import threading

    app = boundary_client.app
    assert app.state.store.latest_manifest() is None
    for name in ("scheduler", "intraday_scheduler", "performance_scheduler"):
        scheduler = getattr(app.state, name)
        assert scheduler._thread is not None and scheduler._thread.is_alive()
    submitted = threading.Event()
    calls = []

    def submit(scope, **kwargs):
        calls.append((scope, kwargs["trigger"]))
        submitted.set()

    monkeypatch.setattr(app.state.jobs, "submit", submit)
    response = boundary_client.put("/v1/settings/automation", json={"liveEnabled": True})
    assert response.status_code == 200
    assert submitted.wait(2)
    assert calls[0] == ("live", "live")


def test_cached_research_status_ages_without_new_snapshot(
    boundary_client, research_root, typed_fixture, monkeypatch
):
    from datetime import UTC, datetime, timedelta

    from services.api.trading_max_api import app as app_module
    from services.api.trading_max_api import research as research_module

    typed_fixture(research_root, boundary_client.app.state.store)
    clock = [datetime.now(UTC)]

    class ResearchClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0]

    monkeypatch.setattr(app_module, "datetime", ResearchClock)
    monkeypatch.setattr(research_module, "datetime", ResearchClock)
    for endpoint in ("/v1/research/shell", "/v1/research"):
        first = boundary_client.get(endpoint).json()
        technical = next(a for a in first["status"]["artifacts"] if a["kind"] == "technical")
        assert technical["freshness"] == "fresh"
    clock[0] += timedelta(days=10)
    for endpoint in ("/v1/research/shell", "/v1/research"):
        later = boundary_client.get(endpoint).json()
        technical = next(a for a in later["status"]["artifacts"] if a["kind"] == "technical")
        assert technical["freshness"] == "stale"


def test_research_overview_keeps_exchange_qualified_selection(
    boundary_client, research_root, typed_fixture
):
    from services.api.trading_max_api.models import SecuritySearchResult

    app = boundary_client.app
    typed_fixture(research_root, app.state.store)
    for ticker in ("BE", "XUSE.L"):
        app.state.watchlist.add(
            SecuritySearchResult(
                ticker=ticker, name=ticker, exchange="TEST", bloomberg_ticker=ticker, figi=""
            )
        )
    response = boundary_client.get("/v1/research", params={"ticker": "XUSE.L"})
    assert response.status_code == 200
    assert response.json()["selected"]["ticker"] == "XUSE.L"


@pytest.mark.parametrize(
    "endpoint", ["/v1/analysis/runs/unknown", "/v1/analysis/artifacts/unknown"]
)
def test_unknown_analysis_resources_return_not_found(boundary_client, endpoint):
    assert boundary_client.get(endpoint).status_code == 404


def test_zero_valued_bull_scenario_does_not_break_research_alerts(boundary_client, monkeypatch):
    from datetime import UTC, datetime

    from services.api.trading_max_api.models import SnapshotManifest

    research = boundary_client.app.state.research
    manifest = SnapshotManifest(
        run_id="synthetic",
        created_at=datetime.now(UTC),
        scope="research",
        source="synthetic",
        artifacts=[],
    )
    monkeypatch.setattr(
        research,
        "ticker_snapshot",
        lambda *args: SimpleNamespace(
            valuation={"modelStatus": "ready", "spot": 10, "valueRange": {"bull": 0}},
            technical=None,
            options=None,
            portfolio_impact=SimpleNamespace(held=False, allocation_pct=0),
        ),
    )
    assert research.alerts("SYNTH", manifest) == []
