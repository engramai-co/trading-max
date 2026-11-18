"""Network-free comparisons against the Pi 0.86.1 wire and parser baselines."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import anyio
import httpx2
import pytest
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.providers.openai_codex import OpenAICodexCredentials
from trading_max.llm import (
    REMOTE_BASE_URLS,
    ModelConnection,
    ProviderError,
    build_model,
    check_connection,
)
from trading_max.llm import model as factory
from trading_max.synthesis.providers.model import ModelProvider

_FIXTURES = json.loads(
    (Path(__file__).parents[1] / "fixtures" / "llm" / "pi_0_86_1.json").read_text()
)
_PRIVACY_FIELDS = {
    "cache_control",
    "cachedContent",
    "conversation",
    "previous_response_id",
    "prompt_cache_breakpoint",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
}
_SESSION_HEADERS = ("session-id", "thread-id", "x-client-request-id")


class _Credentials:
    async def load(self) -> OpenAICodexCredentials:
        return OpenAICodexCredentials(
            access_token="synthetic-access",
            refresh_token="synthetic-refresh",
            account_id="fixture-account",
        )

    async def save(self, _credentials) -> None:
        pytest.fail("a fresh fixture credential must not refresh")


def _connection(provider, model, base_url, *, api_key="synthetic-key") -> ModelConnection:
    codex = provider == "openai-codex"
    return ModelConnection(
        provider,
        model,
        base_url,
        api_key=None if codex else api_key,
        codex_credentials=_Credentials() if codex else None,
    )


def _facade(connection: ModelConnection, *, attempts: int = 1) -> ModelProvider:
    return ModelProvider(
        provider_name=connection.provider,
        model=connection.model,
        base_url=connection.base_url,
        api_key=connection.api_key,
        codex_credentials=connection.codex_credentials,
        max_attempts=attempts,
    )


def _keys(value):
    if isinstance(value, list):
        return {k for item in value for k in _keys(item)}
    if isinstance(value, dict):
        return {*value, *(k for item in value.values() for k in _keys(item))}
    return set()


def _normal_body(provider: str, body: dict, *, historical: bool) -> dict:
    """Normalize the documented equivalents and preserve every other wire field."""
    if historical and "prompt_cache_options" in body:
        # Pi still sent an explicit cache *mode* for GPT-5.6 even with
        # cacheRetention=none. The Python boundary forbids cache hints.
        assert provider == "openai" and body["model"].startswith("gpt-5.6-")
        assert body.pop("prompt_cache_options") == {"mode": "explicit"}
    assert not _PRIVACY_FIELDS.intersection(_keys(body))
    if provider in {"openai", "openai-codex"}:
        for item in body["input"]:
            if item.get("role") == "user" and isinstance(item["content"], list):
                assert len(item["content"]) == 1 and item["content"][0]["type"] == "input_text"
                item["content"] = item["content"][0]["text"]
    elif provider == "anthropic":
        if isinstance(body.get("system"), list):
            assert len(body["system"]) == 1 and body["system"][0]["type"] == "text"
            body["system"] = body["system"][0]["text"]
        if historical and body["model"].startswith("claude-fable-5"):
            # The disabled native tool deferral placeholder is never callable.
            assert body["messages"].pop() == {
                "role": "system",
                "content": [],
                "output_config": {"effort": "high"},
            }
            assert body["output_config"]["effort"] == "high"
            if "tools" in body:
                placeholder = body["tools"].pop()
                assert placeholder["name"] == "__pi_deferred_placeholder__"
                assert placeholder["defer_loading"] is True
        for message in body["messages"]:
            if isinstance(message["content"], list):
                blocks = message["content"]
                if len(blocks) == 1 and blocks[0]["type"] == "text":
                    message["content"] = blocks[0]["text"]
                for block in blocks:
                    if block["type"] == "tool_result" and isinstance(block["content"], list):
                        assert len(block["content"]) == 1 and block["content"][0]["type"] == "text"
                        block["content"] = block["content"][0]["text"]
    elif provider == "google":
        if not historical:
            assert body["generationConfig"].pop("responseModalities") == ["TEXT"]
        if thinking := body["generationConfig"].get("thinkingConfig"):
            for wire, alias in [
                ("thinkingLevel", "thinking_level"),
                ("thinkingBudget", "thinking_budget"),
            ]:
                if alias in thinking:
                    assert wire not in thinking
                    thinking[wire] = thinking.pop(alias)
        for group in body.get("tools", []):
            for declaration in group["functionDeclarations"]:
                if "parameters_json_schema" in declaration:
                    declaration["parametersJsonSchema"] = declaration.pop("parameters_json_schema")
    elif provider in {"deepseek", "opencode"}:
        for tool in body.get("tools", []):
            # Strict function sampling is opt-in on Chat Completions.
            tool["function"].setdefault("strict", False)
    return body


def _request(provider, fixture, *, messages=None):
    context = fixture["context"]
    return provider.complete(
        messages=context["messages"] if messages is None else messages,
        system=context.get("systemPrompt", ""),
        tools=context.get("tools"),
        tool_choice=fixture.get("toolChoice"),
        json_output=fixture.get("json", False),
        schema=fixture.get("schema"),
        max_tokens=fixture.get("maxTokens", 12_000),
        temperature=fixture.get("temperature", 0.1),
        timeout=fixture["timeoutMs"] / 1000,
    )


def _mock_stream(fixture):
    return httpx2.Response(
        200, text=fixture["stream"], headers={"content-type": "text/event-stream"}
    )


def _wire(request: httpx2.Request) -> dict:
    headers = request.headers
    return {
        "endpoint": request.url.path,
        "search": f"?{request.url.query.decode()}" if request.url.query else "",
        "body": json.loads(request.content),
        "auth": (
            "codex-bearer"
            if "chatgpt-account-id" in headers
            else "bearer"
            if "authorization" in headers
            else "x-api-key"
            if "x-api-key" in headers
            else "x-goog-api-key"
            if "x-goog-api-key" in headers
            else "none"
        ),
        "stateHeaders": [header for header in _SESSION_HEADERS if header in headers],
    }


@pytest.mark.parametrize(
    "fixture", _FIXTURES, ids=lambda row: f"{row['provider']}-{row['model']}-{row['label']}"
)
def test_pi_wire_and_response_parity(monkeypatch, fixture):
    name, label = fixture["provider"], fixture["label"]
    current = fixture
    seen = []

    async def transport(request):
        seen.append(_wire(request))
        if name == "anthropic":
            assert request.headers["x-api-key"] == "synthetic-key"
            assert "authorization" not in request.headers
        elif name == "google":
            assert request.headers["x-goog-api-key"] == "synthetic-key"
        elif name == "openai-codex":
            assert request.headers["authorization"] == "Bearer synthetic-access"
            assert request.headers["chatgpt-account-id"] == "fixture-account"
        else:
            assert request.headers["authorization"] == "Bearer synthetic-key"
        mode = current["mode"]
        if mode == "timeout":
            await anyio.sleep_forever()
        if isinstance(mode, int):
            return httpx2.Response(
                mode,
                json={
                    "error": {
                        "message": "sensitive upstream text",
                        "type": "error",
                        "code": mode,
                        "status": "ERROR",
                    }
                },
            )
        return _mock_stream(current)

    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "ambient-synthetic-token")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-synthetic-key")
    monkeypatch.setenv("GEMINI_API_KEY", "ambient-synthetic-key")
    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(transport))
    connection = _connection(name, fixture["model"], fixture["baseUrl"])
    facade = _facade(connection)
    messages = None
    if label == "tool_result":
        current = next(
            item
            for item in _FIXTURES
            if (item["provider"], item["model"], item["label"])
            == (name, fixture["model"], "tool_required")
        )
        assistant = _request(facade, current)["message"]
        pattern = fixture["context"]["messages"]
        messages = [pattern[0], assistant, pattern[2]]
        assert messages[2]["toolCallId"] == assistant["content"][0]["id"]
        seen.clear()
        current = fixture
    expected = fixture["result"]
    if "error" in expected:
        with pytest.raises(ProviderError) as failure:
            _request(facade, fixture)
        assert failure.value.code == expected["error"]
        assert failure.value.__suppress_context__
        assert "sensitive upstream text" not in str(failure.value)
    elif label == "test":
        assert anyio.run(check_connection, connection) is None
    else:
        result = _request(facade, fixture, messages=messages)
        assert result["message"]["model"] == fixture["model"]
        assert {
            "text": result["text"],
            "usage": result["usage"],
            "stop": result["message"]["stopReason"],
            "parts": result["message"]["content"],
        } == expected
        if label == "json":
            assert facade.json(
                system=fixture["context"]["systemPrompt"], user="Synthetic company"
            ) == {"ok": True}
            assert seen.pop() == seen[0]

    assert len(seen) == 1
    old = fixture["wire"]
    actual = seen[0]
    assert {**actual, "body": _normal_body(name, actual["body"], historical=False)} == {
        **old,
        "body": _normal_body(name, json.loads(json.dumps(old["body"])), historical=True),
    }


@pytest.mark.parametrize("provider", REMOTE_BASE_URLS)
def test_remote_redirects_never_forward_keys(monkeypatch, provider):
    seen = []

    def redirect(request):
        seen.append(request.url)
        return httpx2.Response(307, headers={"location": "https://fixture.invalid/leak"})

    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(redirect))
    with pytest.raises(ProviderError, match="provider_unavailable"):
        anyio.run(
            check_connection, _connection(provider, "saved-alias", REMOTE_BASE_URLS[provider])
        )
    assert len(seen) == 1


@pytest.mark.parametrize("provider", REMOTE_BASE_URLS)
def test_ambient_credentials_and_custom_remote_urls_are_rejected(monkeypatch, provider):
    for env in (
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "OPENCODE_API_KEY",
        "OPENROUTER_API_KEY",
        "CODEX_HOME",
    ):
        monkeypatch.setenv(env, "ambient-synthetic-value")
    monkeypatch.setattr(factory, "_base_transport", lambda: pytest.fail("unexpected transport"))
    with pytest.raises(ProviderError, match="provider_not_configured"):
        build_model(ModelConnection(provider, "saved-alias", REMOTE_BASE_URLS[provider]))
    with pytest.raises(ProviderError, match="provider_model_rejected"):
        build_model(
            ModelConnection(provider, "saved-alias", "https://fixture.invalid/v1", "synthetic-key")
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost",
        "http://localhost:0",
        "https://127.0.0.2:1234",
        "http://localhost:1234@fixture.invalid/v1",
        "http://localhost:1234/v1?query",
        "http://localhost.example:1234",
        "http://[::1]:1234",
        "http://localhost:65536",
        "http://localhost:1234\\fixture.invalid",
        "http://localhost:1234/v1#fragment",
    ],
)
def test_local_endpoint_requires_an_explicit_loopback_port(url):
    with pytest.raises(ProviderError, match="provider_model_rejected"):
        build_model(ModelConnection("ollama", "saved-alias", url))


@pytest.mark.parametrize(
    ("provider", "url", "model", "key", "auth"),
    [
        (
            "openrouter",
            "https://openrouter.ai/api/v1",
            "author/saved-alias",
            "synthetic-key",
            "bearer",
        ),
        ("ollama", "http://127.0.0.1:11434/v1", "saved-model:latest", None, "none"),
        ("lmstudio", "https://localhost:1234/v1", "author/saved-alias", None, "none"),
        ("lmstudio", "http://localhost:1234/v1", "saved-alias", "synthetic-key", "bearer"),
    ],
)
def test_new_provider_routes_use_approved_sse_endpoint(
    monkeypatch, provider, url, model, key, auth
):
    fixture = next(
        item for item in _FIXTURES if item["provider"] == "deepseek" and item["label"] == "test"
    )
    calls = []

    def transport(request):
        calls.append(_wire(request))
        return _mock_stream(fixture)

    monkeypatch.setenv("OPENAI_API_KEY", "ambient-key")
    monkeypatch.setenv("OLLAMA_API_KEY", "ambient-key")
    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(transport))
    anyio.run(check_connection, _connection(provider, model, url, api_key=key))
    assert len(calls) == 1
    assert calls[0]["endpoint"] == httpx2.URL(url + "/chat/completions").path
    assert calls[0]["auth"] == auth
    assert calls[0]["body"]["model"] == model
    assert calls[0]["body"]["stream"] is True
    assert not _PRIVACY_FIELDS.intersection(_keys(calls[0]["body"]))


@pytest.mark.parametrize(
    ("statuses", "retries", "expected"),
    [
        ([429, 500, 200], 2, 3),
        ([429, 429, 429, 200], 9, 3),
        ([401, 200], 2, 1),
    ],
)
def test_retries_are_bounded_and_never_retry_auth_errors(monkeypatch, statuses, retries, expected):
    fixture = next(
        item for item in _FIXTURES if item["provider"] == "deepseek" and item["label"] == "test"
    )
    remaining = list(statuses)

    def transport(_request):
        status = remaining.pop(0)
        if status == 200:
            return _mock_stream(fixture)
        return httpx2.Response(status, json={}, headers={"retry-after-ms": "1"})

    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(transport))
    facade = _facade(
        _connection("deepseek", "saved-alias", REMOTE_BASE_URLS["deepseek"]), attempts=retries + 1
    )
    if statuses[expected - 1] == 200:
        assert _request(facade, fixture)["text"] == '{"ok":true}'
    else:
        with pytest.raises(ProviderError) as failure:
            _request(facade, fixture)
        assert failure.value.code in {"provider_auth_failed", "provider_rate_limited"}
    assert len(statuses) - len(remaining) == expected


def test_codex_agent_history_does_not_enable_provider_session(monkeypatch):
    fixture = next(
        item for item in _FIXTURES if item["provider"] == "openai-codex" and item["label"] == "test"
    )
    seen = []

    def transport(request):
        seen.append(_wire(request))
        return _mock_stream(fixture)

    async def run():
        connection = _connection("openai-codex", fixture["model"], fixture["baseUrl"])
        native = build_model(connection)
        messages = [
            ModelRequest(
                parts=[UserPromptPart("Synthetic question")], conversation_id="fixture-conversation"
            )
        ]
        async with native, native.request_stream(messages, {}, ModelRequestParameters()) as stream:
            async for _ in stream:
                pass

    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(transport))
    anyio.run(run)
    assert seen[0]["stateHeaders"] == []
    assert seen[0]["body"]["store"] is False
    assert not _PRIVACY_FIELDS.intersection(_keys(seen[0]["body"]))


def test_retry_after_beyond_budget_is_not_replayed(monkeypatch):
    calls = []

    def retry_after(request):
        calls.append(request.url)
        return httpx2.Response(429, json={}, headers={"retry-after": "600"})

    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(retry_after))
    facade = _facade(
        _connection("deepseek", "saved-alias", REMOTE_BASE_URLS["deepseek"]), attempts=3
    )
    with pytest.raises(ProviderError, match="provider_rate_limited"):
        facade.complete(messages=[{"role": "user", "content": "Synthetic question"}], timeout=1)
    assert len(calls) == 1


def test_authorisation_is_rechecked_before_a_transport_retry(monkeypatch):
    attempts = []
    checks = []

    def check():
        checks.append(len(attempts))
        if attempts:
            raise PermissionError("consent withdrawn")

    def transport(request):
        attempts.append(request.url)
        return httpx2.Response(429, json={}, headers={"retry-after-ms": "1"})

    monkeypatch.setattr(factory, "_base_transport", lambda: httpx2.MockTransport(transport))
    connection = replace(
        _connection("openai", "gpt-5.6-luna", REMOTE_BASE_URLS["openai"]), before_request=check
    )

    async def run():
        native = build_model(connection, max_retries=2)
        async with native:
            await native.request(
                [ModelRequest(parts=[UserPromptPart("Synthetic")])], {}, ModelRequestParameters()
            )

    with pytest.raises(PermissionError, match="consent withdrawn"):
        anyio.run(run)
    assert checks == [0, 1]
    assert len(attempts) == 1
