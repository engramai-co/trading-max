from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore


def test_profile_and_integration_overview_are_non_secret(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=InMemoryCredentialStore(),
    )
    with TestClient(app) as client:
        profile = client.get("/v1/profile")
        assert profile.status_code == 200
        assert profile.json()["profileId"] == "local"

        overview = client.get("/v1/settings/integrations")
        assert overview.status_code == 200
        payload = overview.json()
        assert payload["deploymentMode"] == "local_workstation"
        assert {item["integrationId"] for item in payload["integrations"]} == {
            "trading212:invest",
            "trading212:isa",
            "opencode:default",
            "deepseek:default",
        }
        assert {item["provider"] for item in payload["llmProviders"]} == {
            "opencode",
            "deepseek",
        }
        assert payload["llmRoutePolicy"]["defaultRoute"] == "opencode/deepseek-v4-flash"
        assert all(
            "secretKey" not in item and "apiKey" not in item for item in payload["integrations"]
        )

        assert (
            client.patch(
                "/v1/profile",
                json={"displayName": "Researcher", "initials": "RY", "locale": "en"},
            ).status_code
            == 401
        )
        updated = client.patch(
            "/v1/profile",
            json={"displayName": "Researcher", "initials": "RY", "locale": "en"},
            headers={"Authorization": "Bearer secret"},
        )
        assert updated.status_code == 200
        assert updated.json()["displayName"] == "Researcher"
        assert updated.json()["initials"] == "RY"
        assert updated.json()["locale"] == "en"


def test_settings_writes_require_the_same_write_boundary(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=InMemoryCredentialStore(),
    )
    with TestClient(app) as client:
        response = client.put(
            "/v1/settings/integrations/deepseek",
            json={
                "apiKey": "not-written",
                "model": "deepseek-chat",
                "baseUrl": "https://example.invalid",
            },
        )
        assert response.status_code == 401


def test_automation_settings_persist_and_reconfigure_live_schedulers(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    data_root = tmp_path / "runtime"
    store = ArtifactStore(data_root)
    typed_fixture(research_root, store)
    headers = {"Authorization": "Bearer secret"}
    initial_settings = Settings(
        data_root=data_root,
        api_token="secret",
        nightly_enabled=True,
        intraday_enabled=False,
        embedded_worker=True,
    )
    with TestClient(
        create_app(initial_settings, credential_store=InMemoryCredentialStore())
    ) as client:
        current = client.get("/v1/settings/automation")
        assert current.status_code == 200
        assert current.json()["nightlyEnabled"] is True
        assert current.json()["researchEnabled"] is True
        assert current.json()["performanceEnabled"] is True
        assert current.json()["liveEnabled"] is False
        assert current.json()["nightlyLocalTimes"] == [
            "06:30",
            "12:00",
            "17:30",
            "22:30",
        ]
        assert current.json()["intradayEnabled"] is False
        assert current.json()["intradayIntervalSeconds"] == 600
        assert current.json()["intradayWindowStart"] == "00:00"
        assert current.json()["intradayWindowEnd"] == "00:00"
        assert current.json()["intradayWeekdays"] == [1, 2, 3, 4, 5, 6, 7]

        unauthorized = client.put(
            "/v1/settings/automation",
            json={"nightlyEnabled": False, "intradayEnabled": True},
        )
        assert unauthorized.status_code == 401

        saved = client.put(
            "/v1/settings/automation",
            headers=headers,
            json={
                "nightlyEnabled": False,
                "intradayEnabled": True,
                "expectedRevision": current.json()["revision"],
            },
        )
        assert saved.status_code == 200
        assert saved.json()["nightlyEnabled"] is False
        assert saved.json()["intradayEnabled"] is True
        assert saved.json()["researchEnabled"] is False
        assert saved.json()["performanceEnabled"] is True
        assert saved.json()["liveEnabled"] is True

        refresh_state = client.get("/v1/refresh-state").json()
        assert refresh_state["nightly"]["enabled"] is False
        assert refresh_state["intraday"]["enabled"] is True
        assert refresh_state["research"]["enabled"] is False
        assert refresh_state["performance"]["enabled"] is True
        assert refresh_state["live"]["enabled"] is True

        conflict = client.put(
            "/v1/settings/automation",
            headers=headers,
            json={
                "nightlyEnabled": True,
                "intradayEnabled": True,
                "expectedRevision": current.json()["revision"],
            },
        )
        assert conflict.status_code == 409

        contradictory = client.put(
            "/v1/settings/automation",
            headers=headers,
            json={"liveEnabled": False, "intradayEnabled": True},
        )
        assert contradictory.status_code == 409

    opposite_environment_defaults = Settings(
        data_root=data_root,
        api_token="secret",
        nightly_enabled=True,
        intraday_enabled=False,
        embedded_worker=True,
    )
    with TestClient(
        create_app(
            opposite_environment_defaults,
            credential_store=InMemoryCredentialStore(),
        )
    ) as client:
        persisted = client.get("/v1/settings/automation").json()
        assert persisted["nightlyEnabled"] is False
        assert persisted["intradayEnabled"] is True


def test_trading212_candidate_must_be_tested_before_it_can_be_saved(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    credential_store = InMemoryCredentialStore()
    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings.Trading212Client.snapshot",
        lambda _client: object(),
    )
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=credential_store,
    )
    candidate = {
        "apiKeyId": "candidate-id",
        "secretKey": "candidate-secret",
        "environment": "live",
    }
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        tested = client.post(
            "/v1/settings/integrations/trading212/invest/test",
            headers=headers,
            json=candidate,
        )
        assert tested.status_code == 200
        receipt = tested.json()["validationToken"]
        overview = client.get("/v1/settings/integrations").json()
        invest = next(
            item
            for item in overview["integrations"]
            if item["integrationId"] == "trading212:invest"
        )
        assert invest["configured"] is False

        changed = client.put(
            "/v1/settings/integrations/trading212/invest",
            headers=headers,
            json={
                **candidate,
                "secretKey": "edited-after-test",
                "validationToken": receipt,
            },
        )
        assert changed.status_code == 409

        saved = client.put(
            "/v1/settings/integrations/trading212/invest",
            headers=headers,
            json={**candidate, "validationToken": receipt},
        )
        assert saved.status_code == 200
        assert saved.json()["configured"] is True


def test_deepseek_candidate_test_is_non_persistent_and_receipt_is_bound(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    credential_store = InMemoryCredentialStore()

    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings._check_deepseek_connection",
        lambda **_kwargs: "DeepSeek connectivity check succeeded",
    )
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=credential_store,
    )
    candidate = {
        "apiKey": "deepseek-candidate",
        "model": "deepseek-v4-flash",
        "baseUrl": "https://api.deepseek.com/",
    }
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        tested = client.post(
            "/v1/settings/integrations/deepseek/test",
            headers=headers,
            json=candidate,
        )
        assert tested.status_code == 200
        receipt = tested.json()["validationToken"]
        overview = client.get("/v1/settings/integrations").json()
        deepseek = next(
            item for item in overview["integrations"] if item["integrationId"] == "deepseek:default"
        )
        assert deepseek["configured"] is False

        changed = client.put(
            "/v1/settings/integrations/deepseek",
            headers=headers,
            json={
                **candidate,
                "model": "deepseek-chat",
                "validationToken": receipt,
            },
        )
        assert changed.status_code == 409

        saved = client.put(
            "/v1/settings/integrations/deepseek",
            headers=headers,
            json={**candidate, "validationToken": receipt},
        )
        assert saved.status_code == 200
        assert saved.json()["configured"] is True


def test_opencode_route_is_tested_saved_and_can_update_policy(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    credential_store = InMemoryCredentialStore()
    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings._check_openai_compatible_connection",
        lambda **_kwargs: "OpenCode connectivity check succeeded",
    )
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=credential_store,
    )
    headers = {"Authorization": "Bearer secret"}
    candidate = {"apiKey": "opencode-candidate", "model": "deepseek-v4-flash"}

    with TestClient(app) as client:
        tested = client.post(
            "/v1/settings/llm/providers/opencode/test",
            headers=headers,
            json=candidate,
        )
        assert tested.status_code == 200
        receipt = tested.json()["validationToken"]

        saved = client.put(
            "/v1/settings/llm/providers/opencode",
            headers=headers,
            json={**candidate, "validationToken": receipt},
        )
        assert saved.status_code == 200
        assert saved.json()["provider"] == "opencode"
        assert saved.json()["baseUrl"] == "https://opencode.ai/zen/go/v1"

        current = client.get("/v1/settings/llm/route-policy")
        assert current.status_code == 200
        policy = current.json()
        updated = client.put(
            "/v1/settings/llm/route-policy",
            headers=headers,
            json={
                "defaultRoute": "deepseek/deepseek-chat",
                "overrides": {"ticker": "opencode/deepseek-v4-flash"},
                "expectedRevision": policy["revision"],
            },
        )
        assert updated.status_code == 200
        assert updated.json()["defaultRoute"] == "deepseek/deepseek-chat"


def test_production_write_boundary_rejects_non_loopback_and_cross_site(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=False,
        ),
        credential_store=InMemoryCredentialStore(),
    )
    with TestClient(app) as client:
        payload = {"displayName": "Local"}
        hostile_host = client.patch(
            "/v1/profile",
            headers={"Authorization": "Bearer secret", "Host": "192.168.0.10"},
            json=payload,
        )
        assert hostile_host.status_code == 400
        hostile_origin = client.patch(
            "/v1/profile",
            headers={
                "Authorization": "Bearer secret",
                "Host": "127.0.0.1",
                "Origin": "https://evil.example",
            },
            json=payload,
        )
        assert hostile_origin.status_code == 403
        accepted = client.patch(
            "/v1/profile",
            headers={"Authorization": "Bearer secret", "Host": "127.0.0.1"},
            json=payload,
        )
        assert accepted.status_code == 200
