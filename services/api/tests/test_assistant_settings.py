from __future__ import annotations

import asyncio
import json
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anyio
import httpcore2
import httpx2
import pytest
from fastapi.testclient import TestClient
from pydantic_ai import FunctionToolset
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from trading_max.infrastructure import SqliteDatabase

from services.api.trading_max_api.agent.probe import check_assistant_connection
from services.api.trading_max_api.agent.runtime import build_assistant_agent
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.assistant_settings import ASSISTANT_CONSENT_REVISION
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import (
    CredentialStoreError,
    InMemoryCredentialStore,
    secret_fingerprint,
)
from services.api.trading_max_api.llm_routing import (
    LLMRouteError,
    parse_route,
    provider_base_url,
    provider_routes,
    provider_spec,
)
from services.api.trading_max_api.models import AssistantPreferencesUpdate, LLMRoutePolicyUpdate
from services.api.trading_max_api.oauth import OAuthCredentialVault
from services.api.trading_max_api.provider_runtime import (
    ProviderRuntimeError,
    resolve_assistant_connection,
)
from services.api.trading_max_api.settings import MIGRATIONS, SettingsRepository

_CONSENT = ASSISTANT_CONSENT_REVISION
_PREFERENCES = "/v1/settings/assistant"
_PROVIDERS = "/v1/settings/llm/providers"
_AUTH = {"Authorization": "Bearer synthetic-token"}


def _provider_path(provider: str) -> str:
    return f"{_PROVIDERS}/{provider}/assistant"


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("openrouter", "anthropic/claude-sonnet-5"),
        ("openrouter", "meta-llama/llama-4:free"),
        ("ollama", "llama3.2:3b"),
        ("lmstudio", "qwen2.5-7b-instruct"),
    ],
)
def test_freeform_routes_parse_without_becoming_synthesis_routes(provider: str, model: str) -> None:
    route = parse_route(f"{provider}/{model}", workload="assistant")
    assert (route.provider, route.model) == (provider, model)
    assert provider not in {item["provider"] for item in provider_routes()}
    for workload in ("portfolio", "ticker", "taxonomy"):
        with pytest.raises(LLMRouteError):
            parse_route(route.route_id, workload=workload)


@pytest.mark.parametrize(
    "model",
    ["", "a b", " test", "test\t", "a//b", "a/../b", "a..b", "a?", "a%", "a/ü", "m" * 129],
)
def test_freeform_models_reject_untrusted_ids(model: str) -> None:
    with pytest.raises(LLMRouteError):
        parse_route(f"openrouter/{model}", workload="assistant")


def test_curated_and_legacy_models_keep_their_policies() -> None:
    for route in ("opencode/deepseek-v4-flash", "deepseek/deepseek-chat"):
        assert parse_route(route, workload="assistant").route_id == route
        assert parse_route(route, workload="ticker").route_id == route
    assert {"opencode", "deepseek"}.isdisjoint(item["provider"] for item in provider_routes())
    with pytest.raises(LLMRouteError):
        parse_route("anthropic/unknown-model", workload="assistant")


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost",
        "http://127.0.0.1:80?",
        "http://127.0.0.1:80#",
        "http://localhost:1234/v1?apiKey=synthetic-secret",
        "http://local-user@localhost:1234",
        "http://localhost:1234\\path",
        "http://localhost:0",
        "http://localhost:65536",
        "http://localhost:0x80",
        "http://[::1]:1234",
        "http://127.1:1234",
        "http://127.0.0.2:1234",
        "http://localhost.invalid:1234",
        "http://localhoſt:1234",
        "http://example.invalid:1234",
        "ftp://localhost:1234",
        " http://localhost:1234 ",
    ],
)
def test_loopback_base_url_rejects_unsafe_or_ambiguous_urls(url: str) -> None:
    with pytest.raises(LLMRouteError):
        provider_base_url(provider_spec("ollama"), url)


def test_local_base_urls_allow_ports_paths_and_https_while_remote_urls_are_pinned() -> None:
    assert provider_base_url(provider_spec("ollama")) == "http://127.0.0.1:11434/v1"
    assert provider_base_url(provider_spec("lmstudio")) == "http://127.0.0.1:1234/v1"
    for url in ("http://127.0.0.1:9000", "https://LOCALHOST:8443/custom/v1"):
        assert provider_base_url(provider_spec("ollama"), url) == url
    remote = provider_spec("openrouter")
    assert provider_base_url(remote) == "https://openrouter.ai/api/v1"
    with pytest.raises(LLMRouteError):
        provider_base_url(remote, "https://openrouter.ai/an-unapproved-path")


def test_route_policy_rejects_assistant_routes_without_changing_the_policy(tmp_path: Path) -> None:
    repository = SettingsRepository(tmp_path)
    try:
        previous = repository.get_route_policy()
        for update in (
            LLMRoutePolicyUpdate(default_route="ollama/llama3.2:3b"),
            LLMRoutePolicyUpdate(overrides={"ticker": "openrouter/anthropic/claude-sonnet-5"}),
            LLMRoutePolicyUpdate(overrides={"assistant": "openai/gpt-5.6-luna"}),
        ):
            with pytest.raises(ValueError):
                repository.save_route_policy(update)
        assert repository.get_route_policy() == previous
    finally:
        repository.close()


def test_migration_preserves_all_integration_columns_and_route_policy(tmp_path: Path) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    for migration in MIGRATIONS.glob("*.sql"):
        if migration.name < "0023":
            shutil.copyfile(migration, migrations / migration.name)

    path = tmp_path / "trading_max.db"
    database = SqliteDatabase(path, migrations_dir=migrations)
    with database.transaction() as connection:
        providers = (
            "trading212",
            "deepseek",
            "openai",
            "opencode",
            "alpaca",
            "anthropic",
            "google",
            "openai-codex",
            "eodhd",
        )
        for provider in providers:
            connection.execute(
                "INSERT INTO integration_settings VALUES (?, ?, 'fixture', 1, 'model', "
                "'https://example.invalid', ?, 'fixture-fp', '2020-01-01', 'failed', "
                "'fixture_error', 9, '2020-01-02')",
                (f"{provider}:fixture", provider, f"{provider}:fixture"),
            )
        previous = [
            tuple(row)
            for row in connection.execute("SELECT * FROM integration_settings ORDER BY provider")
        ]
        policy = tuple(connection.execute("SELECT * FROM llm_route_policy").fetchone())
    database.close()

    migration = "0023_assistant_providers.sql"
    shutil.copyfile(MIGRATIONS / migration, migrations / migration)
    database = SqliteDatabase(path, migrations_dir=migrations)
    with database.read() as connection:
        assert [
            tuple(row)
            for row in connection.execute("SELECT * FROM integration_settings ORDER BY provider")
        ] == previous
        assert tuple(connection.execute("SELECT * FROM llm_route_policy").fetchone()) == policy
        assert tuple(
            connection.execute(
                "SELECT enabled, route, reasoning, accepted_consent_revision, accepted_at, revision "
                "FROM assistant_preferences"
            ).fetchone()
        ) == (0, None, None, None, None, 1)
    database.close()


class _UnavailableStore(InMemoryCredentialStore):
    def get(self, reference: str) -> str | None:
        raise CredentialStoreError("synthetic private error")


def _register(
    repository: SettingsRepository,
    provider: str,
    model: str,
    *,
    key: bool = True,
    base_url: str | None = None,
) -> None:
    repository.save_integration(
        provider=provider,
        profile=None,
        enabled=True,
        model=model,
        base_url=base_url or provider_spec(provider).base_url,
        credential_fingerprint=secret_fingerprint("synthetic-secret") if key else None,
        test_status="succeeded",
    )


def _enable(repository: SettingsRepository, route: str):
    return repository.save_assistant_preferences(
        AssistantPreferencesUpdate(
            enabled=True,
            route=route,
            accepted_consent_revision=_CONSENT,
            reasoning="high",
            expected_consent_destination=provider_spec(route.split("/")[0]).base_url,
        )
    )


def test_resolver_has_no_environment_fallback_and_reports_missing_or_unavailable_credentials(
    tmp_path: Path,
) -> None:
    repository = SettingsRepository(tmp_path)
    settings = Settings(data_root=tmp_path, openai_api_key="synthetic-env-key")
    credentials = InMemoryCredentialStore()
    try:

        def check_error(code: str, store=credentials) -> None:
            with pytest.raises(ProviderRuntimeError) as error:
                resolve_assistant_connection(settings, repository, store)
            assert error.value.code == code
            assert "synthetic" not in str(error.value)

        check_error("assistant_disabled")
        _register(repository, "openai", "gpt-5.6-luna", base_url="https://rejected.invalid")
        preferences = _enable(repository, "openai/gpt-5.6-luna")
        check_error("provider_not_configured")
        check_error("credential_store_unavailable", _UnavailableStore())

        credentials.put("openai:default", "synthetic-secret")
        resolved = resolve_assistant_connection(settings, repository, credentials)
        assert resolved.route_id == "openai/gpt-5.6-luna"
        assert resolved.base_url == provider_spec("openai").base_url
        assert resolved.api_key == "synthetic-secret"
        assert resolved.reasoning == "high"
        assert resolved.preferences_revision == preferences.revision
        assert resolved.provider_revision == 1
        assert resolved.consent_revision == _CONSENT
        assert "synthetic-secret" not in repr(resolved)
        assert resolved.to_model_connection().api_key == "synthetic-secret"

        with repository.database.transaction() as connection:
            connection.execute("UPDATE assistant_preferences SET accepted_consent_revision = 999")
        check_error("assistant_consent_required")
        with repository.database.transaction() as connection:
            connection.execute(
                "UPDATE assistant_preferences SET accepted_consent_revision = ?, route = 'unknown/model'",
                (_CONSENT,),
            )
        check_error("provider_route_invalid")
    finally:
        repository.close()


def test_keyless_local_provider_does_not_read_the_credential_manager(tmp_path: Path) -> None:
    repository = SettingsRepository(tmp_path)
    try:
        _register(repository, "ollama", "llama3.2:3b", key=False)
        _enable(repository, "ollama/llama3.2:3b")
        connection = resolve_assistant_connection(
            Settings(data_root=tmp_path), repository, _UnavailableStore()
        )
        assert connection.api_key is None
        assert connection.codex_credentials is None
        assert connection.base_url == provider_spec("ollama").base_url
    finally:
        repository.close()


def test_codex_resolver_returns_native_credential_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    credentials = InMemoryCredentialStore(
        {
            "openai-codex:default": json.dumps(
                {
                    "type": "oauth",
                    "access": "synthetic-access",
                    "refresh": "synthetic-refresh",
                    "accountId": "synthetic-account",
                    "expires": 1,
                }
            )
        }
    )
    repository = SettingsRepository(tmp_path)
    try:
        _register(repository, "openai-codex", "gpt-5.6-luna")
        _enable(repository, "openai-codex/gpt-5.6-luna")
        settings = Settings(data_root=tmp_path)
        resolved = resolve_assistant_connection(settings, repository, credentials)
        assert resolved.api_key is None
        source = resolved.codex_credentials
        assert source is not None
        assert asyncio.run(source.load()).account_id == "synthetic-account"
        assert resolved.to_model_connection().codex_credentials is source
        assert repr(source) not in repr(resolved)

        def reject(self):
            raise ValueError("synthetic-private-error")

        monkeypatch.setattr(OAuthCredentialVault, "credential_source", reject)
        with pytest.raises(ProviderRuntimeError) as error:
            resolve_assistant_connection(settings, repository, credentials)
        assert error.value.code == "provider_auth_failed"
        assert "synthetic-private-error" not in str(error.value)
    finally:
        repository.close()


@pytest.fixture
def assistant_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from trading_max.llm import ProviderError

    attempts = []
    credentials = InMemoryCredentialStore()

    async def connect(connection):
        attempts.append(connection)
        if connection.api_key == "synthetic-rejected":
            raise ProviderError(provider=connection.provider, code="provider_auth_failed")

    monkeypatch.setattr("trading_max.llm.check_connection", connect)
    # The assistant test also requires a tool call; it has its own probe.
    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings.check_assistant_connection", connect
    )
    app = create_app(
        Settings(data_root=tmp_path, api_token="synthetic-token"),
        credential_store=credentials,
    )
    with TestClient(app) as client:
        yield client, attempts, credentials


def test_assistant_preferences_are_explicit_opt_in_and_revision_checked(assistant_client) -> None:
    client, _, _ = assistant_client
    initial = client.get(_PREFERENCES).json()
    assert initial["enabled"] is False
    assert initial["backgroundBriefsEnabled"] is True
    assert initial["shareValuationAssumptions"] is True
    assert initial["route"] is None
    assert initial["acceptedConsentRevision"] is None
    assert initial["consentRevision"] == _CONSENT
    assert {provider["provider"] for provider in initial["providers"]} == {
        "openai",
        "openai-codex",
        "anthropic",
        "google",
        "deepseek",
        "opencode",
        "openrouter",
        "ollama",
        "lmstudio",
    }

    def update(**fields):
        return client.put(_PREFERENCES, json=fields, headers=_AUTH)

    assert client.put(_PREFERENCES, json={"enabled": True}).status_code == 401
    assert update(enabled=True).json()["detail"]["code"] == "assistant_consent_required"
    assert (
        update(acceptedConsentRevision=999).json()["detail"]["code"] == "assistant_consent_required"
    )
    assert (
        update(acceptedConsentRevision=_CONSENT).json()["detail"]["code"]
        == "provider_route_invalid"
    )
    accepted = update(route="openai/gpt-5.6-luna", acceptedConsentRevision=_CONSENT).json()
    assert accepted["acceptedAt"] is not None
    assert update(enabled=True).json()["detail"]["code"] == "provider_not_configured"
    assert (
        update(
            enabled=True,
            route="openrouter/anthropic/claude-sonnet-5",
            acceptedConsentRevision=_CONSENT,
        ).json()["detail"]["code"]
        == "provider_not_configured"
    )
    assert update(reasoning="medium", expectedRevision=initial["revision"]).status_code == 409
    revoked = update(acceptedConsentRevision=None, expectedRevision=accepted["revision"]).json()
    assert revoked["acceptedAt"] is None


@pytest.mark.parametrize(
    ("provider", "model", "url", "key"),
    [
        (
            "openrouter",
            "meta-llama/llama-4:free",
            "https://openrouter.ai/api/v1",
            "synthetic-secret",
        ),
        ("ollama", "llama3.2:3b", "http://127.0.0.1:11434/v1", None),
        ("lmstudio", "qwen2.5-7b-instruct", "https://localhost:8443/custom/v1", "synthetic-secret"),
    ],
)
def test_assistant_provider_checks_candidate_before_save_and_keeps_picker_unchanged(
    assistant_client, provider: str, model: str, url: str, key: str | None
) -> None:
    client, attempts, credentials = assistant_client
    path = _provider_path(provider)
    candidate = {"model": model, "baseUrl": url, "apiKey": key}
    assert client.post(f"{path}/test", json=candidate).status_code == 401
    assert (
        client.put(
            path, headers=_AUTH, json={**candidate, "validationToken": "invalid"}
        ).status_code
        == 409
    )

    tested = client.post(f"{path}/test", headers=_AUTH, json=candidate)
    assert tested.status_code == 200
    assert "synthetic-secret" not in tested.text
    assert credentials.get(f"{provider}:default") is None
    assert len(attempts) == 1
    assert (attempts[0].provider, attempts[0].model, attempts[0].base_url, attempts[0].api_key) == (
        provider,
        model,
        url,
        key,
    )
    receipt = tested.json()["validationToken"]
    changed = client.put(
        path,
        headers=_AUTH,
        json={**candidate, "model": "different-model", "validationToken": receipt},
    )
    assert changed.status_code == 409

    response = client.put(path, headers=_AUTH, json={**candidate, "validationToken": receipt})
    assert response.status_code == 200
    assert response.json()["configured"] is True
    assert response.json()["needsSecret"] is False
    assert credentials.get(f"{provider}:default") == key
    assert "synthetic-secret" not in response.text
    settings = client.put(
        _PREFERENCES,
        headers=_AUTH,
        json={
            "enabled": True,
            "route": f"{provider}/{model}",
            "expectedConsentDestination": url,
            "reasoning": "medium",
            "acceptedConsentRevision": _CONSENT,
        },
    )
    assert settings.status_code == 200
    assert settings.json()["route"] == f"{provider}/{model}"
    assert settings.json()["enabled"] is True

    # The picker tests this stored route, even for a local server with an optional key.
    probe = client.post(f"{path}/test?saved=true", json={"model": model}, headers=_AUTH)
    assert probe.status_code == 200
    assert probe.json()["validationToken"] is None
    assert (attempts[-1].base_url, attempts[-1].api_key) == (url, key)
    if provider == "lmstudio":
        client.post(
            f"{path}/test?saved=true",
            json={"model": model, "baseUrl": "http://localhost:9999/v1"},
            headers=_AUTH,
        ).raise_for_status()
        assert attempts[-1].base_url == url
    old_metadata = client.get(_PROVIDERS).json()
    assert provider not in {item["provider"] for item in old_metadata["integrations"]}
    assert provider not in {item["provider"] for item in old_metadata["providers"]}
    assert client.post(
        f"{_PROVIDERS}/{provider}/test", headers=_AUTH, json=candidate
    ).status_code in {
        404,
        422,
    }
    assert client.delete(path, headers=_AUTH).status_code == 204
    assert credentials.get(f"{provider}:default") is None
    assert (
        client.put(_PREFERENCES, headers=_AUTH, json={"enabled": False}).json()["enabled"] is False
    )


def test_assistant_connection_test_errors_omit_secrets_and_reject_untrusted_urls(
    assistant_client,
) -> None:
    client, attempts, _ = assistant_client
    path = _provider_path("openrouter")
    candidate = {"model": "meta-llama/llama-4:free", "apiKey": "synthetic-rejected"}
    failed = client.post(f"{path}/test", headers=_AUTH, json=candidate)
    assert failed.status_code == 422
    assert failed.json()["detail"]["code"] == "provider_auth_failed"
    assert "synthetic" not in failed.text
    rejected = client.post(
        f"{path}/test", headers=_AUTH, json={**candidate, "baseUrl": "https://example.invalid/v1"}
    )
    assert rejected.json()["detail"]["code"] == "provider_url_not_allowed"
    invalid = client.post(f"{path}/test", headers=_AUTH, json={**candidate, "apiKey": "x" * 501})
    assert invalid.status_code == 422
    assert "x" * 501 not in invalid.text
    assert len(attempts) == 1


def test_assistant_connection_can_test_a_stored_chatgpt_account(
    assistant_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, attempts, credentials = assistant_client
    source = object()
    monkeypatch.setattr(OAuthCredentialVault, "credential_source", lambda self: source)
    credentials.put("openai-codex:default", "synthetic-oauth")
    probe = f"{_provider_path('openai-codex')}/test"
    model = "gpt-5.6-luna"
    _register(client.app.state.settings_repository, "openai-codex", model)
    with monkeypatch.context() as deny:
        deny.setattr(credentials, "get", lambda *_: pytest.fail("read credentials before consent"))
        for path in (probe, probe + "?saved=true"):
            assert client.post(path, headers=_AUTH, json={"model": model}).status_code == 403
    assert attempts == []
    _enable(client.app.state.settings_repository, f"openai-codex/{model}")
    with monkeypatch.context() as deny:
        deny.setattr(
            credentials, "get", lambda *_: pytest.fail("read credentials for another model")
        )
        assert (
            client.post(
                probe + "?saved=true", headers=_AUTH, json={"model": "gpt-5.6-terra"}
            ).status_code
            == 403
        )
    result = client.post(
        f"{_provider_path('openai-codex')}/test", headers=_AUTH, json={"model": "gpt-5.6-luna"}
    )
    assert result.status_code == 200
    assert result.json()["validationToken"] is None
    assert attempts[0].api_key is None
    assert attempts[0].codex_credentials is source


def test_synthesis_connection_uses_the_same_native_check(assistant_client) -> None:
    client, attempts, _ = assistant_client
    response = client.post(
        f"{_PROVIDERS}/anthropic/test",
        headers=_AUTH,
        json={"model": "claude-haiku-4-5-20251001", "apiKey": "synthetic-secret"},
    )
    assert response.status_code == 200
    assert response.json()["validationToken"]
    assert len(attempts) == 1
    assert (attempts[0].provider, attempts[0].base_url) == (
        "anthropic",
        provider_spec("anthropic").base_url,
    )


def test_migrate_consent_and_preserve_model_choice(tmp_path: Path) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    for migration in MIGRATIONS.glob("*.sql"):
        if migration.name < "0025":
            shutil.copyfile(migration, migrations / migration.name)
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=migrations)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE assistant_preferences SET enabled=1, route='openai/gpt-5.4', reasoning='low', "
            "accepted_at='2026-01-01', accepted_consent_revision=1, revision=7"
        )
    database.close()

    repository = SettingsRepository(tmp_path)
    try:
        upgraded = repository.get_assistant_preferences()
        assert (upgraded.route, upgraded.reasoning, upgraded.revision) == (
            "openai/gpt-5.4",
            "low",
            8,
        )
        assert not upgraded.enabled and upgraded.accepted_consent_revision is None
        assert upgraded.accepted_at is None and upgraded.accepted_destination is None
        assert upgraded.background_briefs_enabled and upgraded.share_valuation_assumptions
        with pytest.raises(ProviderRuntimeError, match="enable the assistant"):
            resolve_assistant_connection(
                Settings(data_root=tmp_path), repository, _UnavailableStore()
            )
    finally:
        repository.close()


def test_privacy_preferences_and_consent_follow_the_selected_provider(assistant_client) -> None:
    client, _, _ = assistant_client

    def save(**fields):
        return client.put(_PREFERENCES, headers=_AUTH, json=fields)

    first = save(
        route="openai/gpt-5.4",
        acceptedConsentRevision=_CONSENT,
        backgroundBriefsEnabled=False,
        shareValuationAssumptions=False,
    ).json()
    assert first["backgroundBriefsEnabled"] is False and first["shareValuationAssumptions"] is False
    second = save(route="openai/gpt-5.6-luna").json()
    assert second["acceptedAt"] == first["acceptedAt"]
    assert save(backgroundBriefsEnabled=True, expectedRevision=first["revision"]).status_code == 409
    third = save(route="anthropic/claude-sonnet-5", expectedRevision=second["revision"]).json()
    assert third["acceptedConsentRevision"] is None and third["acceptedAt"] is None
    assert third["backgroundBriefsEnabled"] is False and third["shareValuationAssumptions"] is False
    assert save(backgroundBriefsEnabled=True).json()["shareValuationAssumptions"] is False
    assert save(shareValuationAssumptions=True).json()["backgroundBriefsEnabled"] is True


def test_replacing_a_local_endpoint_invalidates_saved_and_pending_consent(assistant_client):
    client, attempts, _ = assistant_client
    repo = client.app.state.settings_repository
    provider, model = "ollama", "local-model"
    route = f"{provider}/{model}"
    original = provider_spec(provider).base_url
    replacement = "http://127.0.0.1:8456/v1"
    _register(repo, provider, model, key=False)
    _enable(repo, route)
    assert client.get("/v1/assistant/status").json()["ready"]
    _register(repo, provider, model, key=False, base_url=replacement)
    current = client.get(_PREFERENCES).json()
    assert not current["enabled"] and current["acceptedDestination"] is None
    assert (
        current["acceptedConsentRevision"] is None
        and not client.get("/v1/assistant/status").json()["ready"]
    )
    probe = f"{_provider_path(provider)}/test?saved=true"
    assert client.post(probe, headers=_AUTH, json={"model": model}).status_code == 403
    consent = {"enabled": True, "route": route, "acceptedConsentRevision": _CONSENT}
    assert (
        client.put(
            _PREFERENCES, headers=_AUTH, json={**consent, "expectedConsentDestination": original}
        ).status_code
        == 409
    )
    assert client.put(_PREFERENCES, headers=_AUTH, json=consent).status_code == 409
    confirmed = client.put(
        _PREFERENCES, headers=_AUTH, json={**consent, "expectedConsentDestination": replacement}
    ).json()
    assert confirmed["acceptedDestination"] == replacement
    assert client.post(probe, headers=_AUTH, json={"model": model}).status_code == 200
    assert [attempt.base_url for attempt in attempts] == [replacement]


@pytest.mark.parametrize("change", ["turn-off", "withdraw-consent", "replace-endpoint"])
def test_settings_cancel_an_active_turn_before_its_tool_result_is_sent(
    assistant_client, monkeypatch, change
):
    client, _, _ = assistant_client
    repository = client.app.state.settings_repository
    _register(repository, "ollama", "local-model", key=False)
    _enable(repository, "ollama/local-model")
    entered = threading.Event()
    stopped = threading.Event()
    release = threading.Event()
    model_requests = []

    async def read_amount() -> str:
        """Read a synthetic amount."""
        entered.set()
        try:
            await anyio.to_thread.run_sync(release.wait, abandon_on_cancel=True)
        finally:
            stopped.set()
        return "synthetic portfolio result"

    async def model(messages, info):
        model_requests.append(messages)
        if len(model_requests) == 1:
            yield {0: DeltaToolCall(name="read_amount", json_args="{}", tool_call_id="read")}
        else:
            yield "Finished"

    client.app.state.assistant.agent = build_assistant_agent([FunctionToolset([read_amount])])
    monkeypatch.setattr(
        "services.api.trading_max_api.app.build_model",
        lambda connection: FunctionModel(stream_function=model),
    )
    turn = {
        "trigger": "submit-message",
        "id": "cancel-test",
        "messages": [
            {
                "id": "u1",
                "role": "user",
                "parts": [{"type": "text", "text": "Read the synthetic amount"}],
            }
        ],
    }
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, "/v1/assistant/chat", json=turn, headers=_AUTH)
        try:
            assert entered.wait(5)
            if change == "replace-endpoint":
                _register(
                    repository,
                    "ollama",
                    "local-model",
                    key=False,
                    base_url="http://127.0.0.1:8456/v1",
                )
            else:
                update = (
                    {"acceptedConsentRevision": None}
                    if change == "withdraw-consent"
                    else {"enabled": False}
                )
                assert client.put(_PREFERENCES, json=update, headers=_AUTH).status_code == 200
            assert stopped.wait(5), (
                "the active tool should be cancelled without waiting for its result"
            )
            assert '"type":"abort"' in pending.result(timeout=5).text
        finally:
            release.set()
    assert len(model_requests) == 1
    assert client.post("/v1/assistant/chat", json=turn, headers=_AUTH).status_code == 403


def test_background_only_change_allows_an_open_reply_to_finish(assistant_client, monkeypatch):
    client, _, _ = assistant_client
    repository = client.app.state.settings_repository
    _register(repository, "ollama", "local-model", key=False)
    _enable(repository, "ollama/local-model")
    opened, resume = threading.Event(), threading.Event()
    connections = []

    async def reply(messages, info):
        yield "First"
        opened.set()
        await anyio.to_thread.run_sync(resume.wait, abandon_on_cancel=True)
        yield "Finished"

    def build(connection):
        connections.append(connection)
        return FunctionModel(stream_function=reply)

    monkeypatch.setattr("services.api.trading_max_api.app.build_model", build)
    turn = {
        "trigger": "submit-message",
        "id": "open-reply",
        "messages": [
            {"id": "u1", "role": "user", "parts": [{"type": "text", "text": "Hello"}]},
        ],
    }
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, "/v1/assistant/chat", json=turn, headers=_AUTH)
        try:
            assert opened.wait(5)
            client.put(
                _PREFERENCES, json={"backgroundBriefsEnabled": False}, headers=_AUTH
            ).raise_for_status()
            with pytest.raises(ProviderRuntimeError, match="assistant_settings_changed"):
                connections[0].before_request()
        finally:
            resume.set()
        response = pending.result(timeout=5)
    assert response.status_code == 200 and "Finished" in response.text
    assert '"type":"abort"' not in response.text


def test_a_bound_connection_checks_current_consent_and_generation_on_every_request(
    assistant_client,
):
    client, _, credentials = assistant_client
    repository = client.app.state.settings_repository
    _register(repository, "ollama", "local-model", key=False)
    route = "ollama/local-model"
    _enable(repository, route)
    bound = resolve_assistant_connection(
        client.app.state.settings, repository, credentials
    ).to_model_connection()
    bound.before_request()
    client.put(
        _PREFERENCES, json={"enabled": False, "acceptedConsentRevision": None}, headers=_AUTH
    ).raise_for_status()
    with pytest.raises(ProviderRuntimeError, match="assistant_disabled"):
        bound.before_request()
    _enable(repository, route)
    with pytest.raises(ProviderRuntimeError, match="assistant_settings_changed"):
        bound.before_request()


def test_consent_and_integration_come_from_one_read_snapshot(assistant_client, monkeypatch):
    client, _, _ = assistant_client
    repo = client.app.state.settings_repository
    _register(repo, "ollama", "local-model", key=False)
    _enable(repo, "ollama/local-model")
    preferences_read, resume = threading.Event(), threading.Event()
    get_integration = repo.get_integration

    def pause_before_integration(provider):
        preferences_read.set()
        assert resume.wait(8)
        return get_integration(provider)

    monkeypatch.setattr(repo, "get_integration", pause_before_integration)
    writer = SettingsRepository(repo.database.path.parent)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(repo.assistant_connection_snapshot)
            try:
                assert preferences_read.wait(5)
                _register(
                    writer, "ollama", "local-model", key=False, base_url="http://127.0.0.1:8456/v1"
                )
            finally:
                resume.set()
            current, integration, _ = pending.result(timeout=5)
        assert current.enabled
        assert (
            current.accepted_destination == integration.base_url == provider_spec("ollama").base_url
        )
        assert not repo.assistant_dispatch_state(integration.integration_id)[0]
    finally:
        writer.close()


def test_recreating_the_selected_integration_cannot_reuse_an_old_turn(assistant_client):
    client, _, credentials = assistant_client
    repo = client.app.state.settings_repository
    _register(repo, "ollama", "local-model", key=False)
    _enable(repo, "ollama/local-model")
    bound = resolve_assistant_connection(client.app.state.settings, repo, credentials)
    writer = SettingsRepository(repo.database.path.parent)
    try:
        _register(writer, "lmstudio", "another-model", key=False)
        bound.before_request()
        writer.remove_integration(provider="ollama", profile=None)
        _register(writer, "ollama", "local-model", key=False)
        assert writer.get_integration("ollama").revision == bound.provider_revision
        with pytest.raises(ProviderRuntimeError, match="assistant_settings_changed"):
            bound.before_request()
    finally:
        writer.close()


def _tool_response(*, chat: bool) -> bytes:
    name, arguments = ("read_amount", "{}") if chat else ("connection_check", '{"value":"ok"}')
    call = {"id": "read", "type": "function", "function": {"name": name, "arguments": arguments}}
    response = {"id": "synthetic", "created": 1, "model": "local-model"}
    if chat:
        response["object"] = "chat.completion.chunk"
        chunks = [
            {
                **response,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "tool_calls": [{"index": 0, **call}]},
                        "finish_reason": None,
                    }
                ],
            },
            {
                **response,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
            },
        ]
        data = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        content_type = "text/event-stream"
    else:
        response["object"] = "chat.completion"
        response["choices"] = [
            {
                "index": 0,
                "message": {"role": "assistant", "tool_calls": [call]},
                "finish_reason": "tool_calls",
            }
        ]
        data = json.dumps(response)
        content_type = "application/json"
    body = data.encode()
    return (
        "HTTP/1.1 200 OK\r\nConnection: close\r\n"
        f"Content-Type: {content_type}\r\nContent-Length: {len(body)}\r\n\r\n"
    ).encode() + body


@pytest.mark.parametrize(
    ("chat", "headers_sent"),
    [(False, False), (True, False), (True, True)],
    ids=[
        "withdraw-saved-probe",
        "replace-endpoint-before-chat-headers",
        "replace-endpoint-before-chat-body",
    ],
)
def test_queued_tool_result_rechecks_access_at_wire_dispatch(
    assistant_client, monkeypatch, chat, headers_sent
):
    client, _, _ = assistant_client
    repo = client.app.state.settings_repository
    _register(repo, "ollama", "local-model", key=False)
    _enable(repo, "ollama/local-model")
    waiting = threading.Event()
    resume = threading.Event()
    second_writes = []
    read = []

    def read_amount() -> str:
        """Read a synthetic amount."""
        read.append(True)
        return "synthetic amount"

    async def wait_for_change():
        waiting.set()
        await anyio.to_thread.run_sync(resume.wait, abandon_on_cancel=True)

    class SecondStream(httpcore2.AsyncMockStream):
        async def write(self, buffer, **kwargs):
            part = "headers" if buffer.startswith(b"POST ") else "body"
            second_writes.append(part)
            if headers_sent and part == "headers":
                await wait_for_change()

    class Network(httpcore2.AsyncMockBackend):
        initial = True

        async def connect_tcp(self, **kwargs):
            if self.initial:
                self.initial = False
                return httpcore2.AsyncMockStream([_tool_response(chat=chat)])
            if not headers_sent:
                await wait_for_change()
            return SecondStream([])

    def transport():
        native = httpx2.AsyncHTTPTransport(trust_env=False)
        native._pool._network_backend = Network([])  # noqa: SLF001 - substitute only the network
        return native

    monkeypatch.setattr("trading_max.llm.model._base_transport", transport)
    monkeypatch.setattr(
        "services.api.trading_max_api.routes.settings.check_assistant_connection",
        check_assistant_connection,
    )
    if chat:
        client.app.state.assistant.agent = build_assistant_agent([FunctionToolset([read_amount])])
        path = "/v1/assistant/chat"
        body = {
            "trigger": "submit-message",
            "id": "queued",
            "messages": [
                {
                    "id": "u1",
                    "role": "user",
                    "parts": [{"type": "text", "text": "Read the synthetic amount"}],
                }
            ],
        }
    else:
        path = f"{_provider_path('ollama')}/test?saved=true"
        body = {"model": "local-model"}

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, path, headers=_AUTH, json=body)
        try:
            assert waiting.wait(8)
            if chat:
                assert read == [True]
                # An independent repository has no access to the active run's in-memory token.
                writer = SettingsRepository(repo.database.path.parent)
                try:
                    _register(
                        writer,
                        "ollama",
                        "local-model",
                        key=False,
                        base_url="http://127.0.0.1:8456/v1",
                    )
                finally:
                    writer.close()
            else:
                client.put(
                    _PREFERENCES, json={"acceptedConsentRevision": None}, headers=_AUTH
                ).raise_for_status()
                # Cancelling the probe releases it even if the connection never becomes ready.
                assert pending.result(timeout=5).status_code == 403
        finally:
            resume.set()
        response = pending.result(timeout=5)
    if chat:
        assert response.status_code == 200 and "assistant_disabled" in response.text
    assert second_writes == (["headers"] if headers_sent else [])


def test_saved_probe_rejects_a_replacement_key_before_its_metadata_is_saved(
    assistant_client, monkeypatch
):
    client, attempts, credentials = assistant_client
    repo = client.app.state.settings_repository
    provider, model = "ollama", "local-model"
    path = _provider_path(provider)
    credentials.put("ollama:default", "synthetic-secret")
    _register(repo, provider, model)
    _enable(repo, f"{provider}/{model}")
    new_url = "http://127.0.0.1:8456/v1"
    candidate = {"model": model, "baseUrl": new_url, "apiKey": "replacement-key"}
    tested = client.post(f"{path}/test", headers=_AUTH, json=candidate)
    tested.raise_for_status()
    receipt = tested.json()["validationToken"]
    attempts.clear()

    key_written, finish_save = threading.Event(), threading.Event()
    put = credentials.put

    def pause_after_put(reference, value):
        put(reference, value)
        key_written.set()
        assert finish_save.wait(8)

    monkeypatch.setattr(credentials, "put", pause_after_put)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(
            client.put, path, headers=_AUTH, json={**candidate, "validationToken": receipt}
        )
        try:
            assert key_written.wait(5)
            assert repo.get_integration(provider).base_url == provider_spec(provider).base_url
            result = client.post(f"{path}/test?saved=true", headers=_AUTH, json={"model": model})
            assert result.status_code == 403
            assert result.json()["detail"]["code"] == "assistant_settings_changed"
            assert not client.get("/v1/assistant/status").json()["ready"]
            assert attempts == []
        finally:
            finish_save.set()
        pending.result(timeout=5).raise_for_status()

    client.put(
        _PREFERENCES,
        headers=_AUTH,
        json={
            "route": f"{provider}/{model}",
            "enabled": True,
            "acceptedConsentRevision": _CONSENT,
            "expectedConsentDestination": new_url,
        },
    ).raise_for_status()
    client.post(f"{path}/test?saved=true", headers=_AUTH, json={"model": model}).raise_for_status()
    assert [(attempt.base_url, attempt.api_key) for attempt in attempts] == [
        (new_url, candidate["apiKey"])
    ]


def test_background_binding_and_dispatch_require_current_background_consent(assistant_client):
    client, _, credentials = assistant_client
    repo = client.app.state.settings_repository
    _register(repo, "ollama", "local-model", key=False)
    _enable(repo, "ollama/local-model")

    def bind():
        return resolve_assistant_connection(
            client.app.state.settings, repo, credentials, background=True
        )

    bound = bind()
    chat = resolve_assistant_connection(client.app.state.settings, repo, credentials)
    bound.before_request()
    client.put(
        _PREFERENCES, json={"backgroundBriefsEnabled": False}, headers=_AUTH
    ).raise_for_status()
    assert bound.cancellation_token.cancelled and not chat.cancellation_token.cancelled
    for check in [bound.before_request, bind]:
        with pytest.raises(ProviderRuntimeError, match="assistant_disabled"):
            check()
