from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from trading_max.onboarding import (
    OnboardingError,
    _configure_trading212_profile,
    _request,
    configure_integrations,
)


def test_supported_web_start_is_loopback_only() -> None:
    repository = Path(__file__).resolve().parents[3]
    package = json.loads((repository / "apps" / "web" / "package.json").read_text(encoding="utf-8"))

    start = package["scripts"]["start"]
    assert "--hostname 127.0.0.1" in start
    assert "--port 3413" in start


def test_request_redacts_provider_failure_detail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer internal-token"
        return httpx.Response(
            422,
            json={
                "detail": {
                    "code": "provider_auth_failed",
                    "message": "integration test failed; no secret was returned",
                }
            },
        )

    with (
        httpx.Client(
            base_url="http://127.0.0.1:8421",
            transport=httpx.MockTransport(handler),
        ) as client,
        pytest.raises(
            OnboardingError,
            match="integration test failed; no secret was returned",
        ),
    ):
        _request(
            client,
            "POST",
            "/v1/settings/llm/providers/opencode/test",
            token="internal-token",
            payload={"apiKey": "not-logged", "model": "deepseek-v4-flash"},
        )


def test_noninteractive_integration_setup_makes_no_requests() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(500)

    with httpx.Client(
        base_url="http://127.0.0.1:8421",
        transport=httpx.MockTransport(handler),
    ) as client:
        assert (
            configure_integrations(
                client,
                token="internal-token",
                interactive=False,
            )
            is False
        )
    assert requests == []


def test_broker_connection_is_tested_before_it_is_saved(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/test"):
            return httpx.Response(
                200,
                json={
                    "integrationId": "trading212:invest",
                    "status": "succeeded",
                    "testedAt": "2026-08-12T00:00:00Z",
                    "message": "ok",
                    "validationToken": "short-lived-receipt",
                },
            )
        return httpx.Response(
            200,
            json={
                "integrationId": "trading212:invest",
                "provider": "trading212",
                "profile": "invest",
                "enabled": True,
                "configured": True,
                "needsSecret": False,
                "lastTestStatus": "succeeded",
                "revision": 1,
                "updatedAt": "2026-08-12T00:00:00Z",
            },
        )

    answers = iter(["key-id", "secret-value"])
    monkeypatch.setattr("trading_max.onboarding._confirm", lambda *_args, **_kwargs: True)
    with httpx.Client(
        base_url="http://127.0.0.1:8421",
        transport=httpx.MockTransport(handler),
    ) as client:
        assert _configure_trading212_profile(
            client,
            token="internal-token",
            profile="invest",
            secret_reader=lambda _prompt: next(answers),
        )

    assert [request.method for request in requests] == ["POST", "PUT"]
    tested = json.loads(requests[0].content)
    saved = json.loads(requests[1].content)
    assert tested["secretKey"] == "secret-value"
    assert saved["validationToken"] == "short-lived-receipt"
    assert all(request.headers["authorization"] == "Bearer internal-token" for request in requests)
