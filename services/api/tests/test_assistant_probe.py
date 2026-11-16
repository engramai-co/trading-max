"""The assistant connection check requires a working tool call."""

from __future__ import annotations

import asyncio

import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from trading_max.llm import ModelConnection, ProviderError

from services.api.trading_max_api.agent import probe
from services.api.trading_max_api.provider_runtime import ProviderRuntimeError

CONNECTION = ModelConnection(
    provider="ollama", model="llama3.2:3b", base_url="http://127.0.0.1:11434/v1", api_key=None
)


def _returned(messages) -> bool:
    last = messages[-1]
    return isinstance(last, ModelRequest) and any(
        isinstance(part, ToolReturnPart) for part in last.parts
    )


def _check(monkeypatch, function) -> None:
    built = []

    def build(connection, **options):
        built.append((connection, options))
        return FunctionModel(function=function)

    monkeypatch.setattr(probe, "build_model", build)
    asyncio.run(probe.check_assistant_connection(CONNECTION))
    assert built == [(CONNECTION, {"timeout_s": 30.0, "max_retries": 0})]


def test_a_model_that_calls_the_tool_passes(monkeypatch):
    def capable(messages, info):
        if _returned(messages):
            return ModelResponse(parts=[TextPart("ok")])
        return ModelResponse(parts=[ToolCallPart("connection_check", {"value": "ok"})])

    _check(monkeypatch, capable)


def test_a_model_that_never_calls_tools_is_reported(monkeypatch):
    def text_only(messages, info):
        return ModelResponse(parts=[TextPart("ok")])

    with pytest.raises(ProviderRuntimeError) as raised:
        _check(monkeypatch, text_only)
    assert raised.value.code == "assistant_tools_unsupported"


def test_a_model_that_loops_on_tools_is_reported(monkeypatch):
    def looping(messages, info):
        return ModelResponse(parts=[ToolCallPart("connection_check", {"value": "ok"})])

    with pytest.raises(ProviderRuntimeError) as raised:
        _check(monkeypatch, looping)
    assert raised.value.code == "assistant_tools_unsupported"


def test_provider_failures_keep_their_stable_code(monkeypatch):
    def rejected(messages, info):
        raise ModelHTTPError(status_code=401, model_name="m", body={"error": "sk-SECRET"})

    with pytest.raises(ProviderError) as raised:
        _check(monkeypatch, rejected)
    assert raised.value.code == "provider_auth_failed"
    assert "SECRET" not in str(raised.value)
