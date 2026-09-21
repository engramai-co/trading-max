from __future__ import annotations

import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from trading_max.synthesis.providers.pi import ProviderError

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import CredentialStoreError, InMemoryCredentialStore
from services.api.trading_max_api.oauth import REFERENCE, OAuthCredentialVault, OAuthLoginManager
from services.api.trading_max_api.provider_runtime import make_provider_factory
from services.api.trading_max_api.settings import SettingsRepository


def credential(refresh="synthetic-refresh"):
    return {
        "type": "oauth",
        "access": "synthetic-access",
        "refresh": refresh,
        "expires": 1234,
        "accountId": "synthetic-account",
    }


class LoginProcess:
    """Synthetic pipe producer: no network, account, or native credential writes."""

    def __init__(self, events):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO("".join(json.dumps(event) + "\n" for event in events))
        self.code = None

    def poll(self):
        return self.code

    def terminate(self):
        self.code = -15

    def kill(self):
        self.code = -9

    def wait(self, timeout=None):
        self.code = self.code or 0
        return self.code


def fake_child(monkeypatch, events):
    def popen(args, **kwargs):
        assert len(args) == 2 and args[1].endswith("/index.mjs")
        assert "OPENAI_API_KEY" not in kwargs["env"]
        return LoginProcess(events)

    monkeypatch.setattr("services.api.trading_max_api.oauth.subprocess.Popen", popen)


def await_status(client, session_id, headers):
    for _ in range(100):
        response = client.get(f"/v1/settings/llm/oauth/openai/{session_id}", headers=headers)
        if response.json()["state"] not in {"starting", "pending"}:
            return response
        time.sleep(0.01)
    pytest.fail("login did not finish")


def test_oauth_login_saves_native_secret_and_default_without_exposing_tokens(tmp_path, monkeypatch):
    fake_child(monkeypatch, [{"credential": credential()}])
    credentials = InMemoryCredentialStore()
    settings = Settings(data_root=tmp_path, api_token="fixture-token", llm_provider="openai")
    headers = {"Authorization": "Bearer fixture-token"}
    with TestClient(create_app(settings, credential_store=credentials)) as client:
        path = "/v1/settings/llm/oauth/openai/start"
        assert client.post(path, json={}).status_code == 401
        started = client.post(
            path, json={"model": "gpt-5.6-luna", "useAsDefault": True}, headers=headers
        )
        assert started.status_code == 200
        session = started.json()["sessionId"]
        assert client.get(f"/v1/settings/llm/oauth/openai/{session}").status_code == 401
        completed = await_status(client, session, headers)
        assert completed.json()["state"] == "connected"
        assert completed.headers["cache-control"] == "private, no-store"
        assert completed.json()["userCode"] is None
        assert json.loads(credentials.get(REFERENCE)) == credential()
        overview = client.get("/v1/settings/integrations")
        assert "synthetic-access" not in completed.text + overview.text
        assert "synthetic-refresh" not in completed.text + overview.text
        assert "synthetic-account" not in completed.text + overview.text
        assert overview.json()["llmRoutePolicy"]["defaultRoute"] == "openai-codex/gpt-5.6-luna"
        assert (
            client.post(
                "/v1/settings/llm/providers/openai-codex/test",
                headers=headers,
                json={"apiKey": "synthetic-key", "model": "gpt-5.6-luna"},
            ).status_code
            == 422
        )
        assert (
            client.delete("/v1/settings/llm/providers/openai-codex", headers=headers).status_code
            == 204
        )
        assert credentials.get(REFERENCE) is None


def test_failed_login_is_safe_and_never_overwrites_existing_connection(tmp_path, monkeypatch):
    fake_child(monkeypatch, [{"error": "private upstream failure: synthetic-secret"}])
    credentials = InMemoryCredentialStore({REFERENCE: json.dumps(credential())})
    with TestClient(
        create_app(Settings(data_root=tmp_path), credential_store=credentials)
    ) as client:
        before = client.get("/v1/settings/llm/routes").json()
        session = client.post("/v1/settings/llm/oauth/openai/start", json={}).json()["sessionId"]
        response = await_status(client, session, {})
        assert response.json()["errorCode"] == "oauth_login_failed"
        assert "synthetic-secret" not in response.text
        assert json.loads(credentials.get(REFERENCE)) == credential()
        assert client.get("/v1/settings/llm/routes").json() == before


def test_rotating_refresh_is_serialized_and_persisted_before_inference(tmp_path, monkeypatch):
    credentials = InMemoryCredentialStore({REFERENCE: json.dumps(credential())})
    calls = []

    def invoke(request, timeout):
        if request.get("operation") == "resolve":
            calls.append(request["credential"]["refresh"])
            time.sleep(0.01)
            return {
                "auth": {"apiKey": "rotated-access"},
                "credential": credential("rotated-refresh"),
            }
        assert json.loads(credentials.get(REFERENCE))["refresh"] == "rotated-refresh"
        raise ProviderError(provider="openai-codex", code="provider_unavailable")

    monkeypatch.setattr("services.api.trading_max_api.oauth._invoke", invoke)
    monkeypatch.setattr("trading_max.synthesis.providers.pi._invoke", invoke)
    vaults = [OAuthCredentialVault(tmp_path, credentials) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda vault: vault.authorize(), vaults))
    assert calls == ["synthetic-refresh", "rotated-refresh"]
    assert results == [{"apiKey": "rotated-access"}] * 2
    with pytest.raises(ProviderError):
        vaults[0].provider("gpt-5.6-luna").complete(messages=[])
    assert json.loads(credentials.get(REFERENCE))["refresh"] == "rotated-refresh"
    assert "synthetic" not in (tmp_path / ".openai-oauth.lock").read_text()


def test_keychain_failure_does_not_report_connected_or_change_default(tmp_path, monkeypatch):
    fake_child(monkeypatch, [{"credential": credential()}])

    class Unavailable(InMemoryCredentialStore):
        def put(self, reference, secret):
            raise CredentialStoreError("keychain locked")

    with TestClient(
        create_app(Settings(data_root=tmp_path), credential_store=Unavailable())
    ) as client:
        before = client.get("/v1/settings/llm/routes").json()
        session = client.post("/v1/settings/llm/oauth/openai/start", json={}).json()["sessionId"]
        response = await_status(client, session, {})
        assert response.json()["state"] == "error"
        assert response.json()["errorCode"] == "credential_store_unavailable"
        assert client.get("/v1/settings/llm/routes").json() == before


def test_cancelled_login_cannot_save_late_credentials_and_can_restart(tmp_path, monkeypatch):
    release = threading.Event()

    class Delayed(LoginProcess):
        def __iter__(self):
            release.wait(timeout=2)
            yield json.dumps({"credential": credential()})

        def close(self):
            pass

    def popen(*args, **kwargs):
        process = Delayed([])
        process.stdout = process
        return process

    monkeypatch.setattr("services.api.trading_max_api.oauth.subprocess.Popen", popen)
    credentials = InMemoryCredentialStore()
    preferences = SettingsRepository(tmp_path)
    manager = OAuthLoginManager(OAuthCredentialVault(tmp_path, credentials), preferences)
    first = manager.start("gpt-5.6-luna", True)
    manager.cancel(first.session_id)
    release.set()
    manager.close()
    assert manager.status(first.session_id).state == "cancelled"
    assert credentials.get(REFERENCE) is None
    preferences.close()


def test_oauth_factory_resolves_latest_credential_at_request_time(tmp_path, monkeypatch):
    preferences = SettingsRepository(tmp_path)
    credentials = InMemoryCredentialStore()
    vault = OAuthCredentialVault(tmp_path, credentials)
    vault.save(credential(), preferences, "gpt-5.6-luna", True)
    factory = make_provider_factory(
        Settings(data_root=tmp_path, llm_provider="openai"), preferences, credentials
    )
    provider = factory("ticker")
    assert provider.name == "openai-codex" and provider.model == "gpt-5.6-luna"
    assert provider.api_key == ""
    vault.delete(preferences)
    with pytest.raises(ProviderError, match="provider_not_configured"):
        provider.complete(messages=[])
    preferences.close()
