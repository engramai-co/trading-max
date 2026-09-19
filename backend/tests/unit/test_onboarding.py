from __future__ import annotations

import json
import subprocess
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
import trading_max.onboarding as onboarding
from trading_max.onboarding import (
    OnboardingError,
    _configure_trading212_profile,
    _request,
    configure_integrations,
)
from trading_max.source_checkout import SourceCheckout


@pytest.mark.parametrize("node_version", ["v20.0.0", "v20.18.3", "v18.20.8"])
def test_preflight_enforces_the_declared_minimum_node_release(
    tmp_path: Path,
    monkeypatch,
    node_version: str,
) -> None:
    (tmp_path / "pyproject.toml").write_text("", encoding="utf-8")
    monkeypatch.setattr(
        onboarding,
        "_tool_version",
        lambda command, *_args: node_version if command == "node" else "fixture",
    )
    monkeypatch.setattr(
        onboarding,
        "inspect_source_checkout",
        lambda root: SourceCheckout(root, "a" * 40, "main", False, "origin"),
    )

    with pytest.raises(OnboardingError, match=r"20\.19"):
        onboarding.preflight(tmp_path)


@pytest.mark.parametrize("node_version", ["v20.19.0", "v20.20.1", "v22.0.0", "v24.1.0"])
def test_preflight_accepts_supported_node_releases(
    tmp_path: Path,
    monkeypatch,
    node_version: str,
) -> None:
    (tmp_path / "pyproject.toml").write_text("", encoding="utf-8")
    monkeypatch.setattr(
        onboarding,
        "_tool_version",
        lambda command, *_args: node_version if command == "node" else "fixture",
    )
    monkeypatch.setattr(
        onboarding,
        "inspect_source_checkout",
        lambda root: SourceCheckout(root, "a" * 40, "main", False, "origin"),
    )

    onboarding.preflight(tmp_path)


@pytest.mark.parametrize("node_version", ["v20", "v20.19", "v20.19.0-rc.1", "unknown"])
def test_preflight_reports_malformed_node_versions(
    tmp_path: Path,
    monkeypatch,
    node_version: str,
) -> None:
    (tmp_path / "pyproject.toml").write_text("", encoding="utf-8")
    monkeypatch.setattr(
        onboarding,
        "_tool_version",
        lambda command, *_args: node_version if command == "node" else "fixture",
    )

    with pytest.raises(OnboardingError, match="could not parse Node version"):
        onboarding.preflight(tmp_path)


def test_empty_tool_version_is_a_controlled_onboarding_error(monkeypatch) -> None:
    monkeypatch.setattr(onboarding.shutil, "which", lambda command: command)
    monkeypatch.setattr(
        onboarding.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "", ""),
    )

    with pytest.raises(OnboardingError, match="returned no version information"):
        onboarding._tool_version("node", "--version")


def test_request_reports_malformed_local_api_json() -> None:
    with (
        httpx.Client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, text="not JSON"))
        ) as client,
        pytest.raises(OnboardingError, match="unexpected response"),
    ):
        _request(client, "GET", "http://127.0.0.1:8421/v1/settings/integrations", token="synthetic")


def test_request_reports_connection_failure_without_transport_detail() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("synthetic-sensitive-transport-detail")

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(OnboardingError, match="could not reach the local API") as error,
    ):
        _request(client, "GET", "http://127.0.0.1:8421/v1/settings/integrations", token="synthetic")
    assert "synthetic-sensitive" not in str(error.value)


def test_preserving_analysis_configuration_does_not_claim_fake_provider_or_no_egress(
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(onboarding, "_choose", lambda *_args, **_kwargs: 0)
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: pytest.fail("keeping configuration must not query providers")
        )
    ) as client:
        assert not onboarding._configure_llm(client, token="synthetic")
    output = capsys.readouterr().out
    assert "current analysis configuration kept" in output
    assert "fake provider kept" not in output
    assert "no portfolio data will leave" not in output


def test_foreground_onboarding_start_command_preserves_the_selected_state_root(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    app_root = tmp_path / "checkout"
    build = app_root / "apps" / "web" / ".next"
    build.mkdir(parents=True)
    (build / "BUILD_ID").write_text("synthetic-build", encoding="utf-8")
    state_root = tmp_path / "isolated state"
    monkeypatch.setattr(onboarding, "preflight", lambda _root: None)
    monkeypatch.setattr(
        onboarding,
        "_load_bootstrap",
        lambda _path: {
            "TRADING_MAX_API_TOKEN": "synthetic",
            "PORTFOLIO_BACKEND_TOKEN": "synthetic",
        },
    )
    monkeypatch.setattr(onboarding, "configure_integrations", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(onboarding, "install_macos_service", lambda _options: False)

    @contextmanager
    def fake_api(**_kwargs):
        yield None

    monkeypatch.setattr(onboarding, "temporary_api", fake_api)
    options = onboarding.OnboardingOptions(app_root, state_root, False, False, "skip", False)

    assert onboarding.onboard(options, initialize=lambda _root: 0) == 0
    assert f"TRADING_MAX_STATE_ROOT='{state_root}' deploy/local/start.sh" in capsys.readouterr().out


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
