from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from services.api.trading_max_api.provider_runtime import ProviderRuntimeError
from services.api.trading_max_api.security_entity_resolution import (
    WEB_SEARCH_MCP_URL,
    OpenCodeWebSearchResolver,
)


@pytest.mark.parametrize("provider_name", ["opencode", "deepseek"])
def test_resolver_runs_one_websearch_tool_call(provider_name: str) -> None:
    web_requests = []
    model_calls = []

    def handler(request):
        web_requests.append(request)
        assert str(request.url) == WEB_SEARCH_MCP_URL
        body = json.loads(request.content)
        assert body["params"]["arguments"]["query"] == "Google parent ticker"
        return httpx.Response(
            200,
            json={
                "result": {
                    "content": [
                        {"type": "text", "text": "Alphabet GOOGL and GOOG https://abc.xyz/"}
                    ]
                }
            },
        )

    def complete(**kwargs):
        model_calls.append(kwargs)
        if len(model_calls) == 1:
            assert kwargs["tool_choice"] == "required"
            assert kwargs["tools"][0]["name"] == "websearch"
            return {
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "call_1",
                            "name": "websearch",
                            "arguments": {"query": "Google parent ticker"},
                        }
                    ],
                }
            }
        assert kwargs["tool_choice"] == "none"
        assert kwargs["messages"][-1]["role"] == "toolResult"
        assert kwargs["messages"][-1]["toolCallId"] == "call_1"
        assert "Alphabet" in kwargs["messages"][-1]["content"][0]["text"]
        return {
            "text": json.dumps(
                {
                    "resolved": True,
                    "companyName": "Alphabet Inc.",
                    "searchQueries": ["GOOGL", "GOOG"],
                    "evidenceUrls": ["https://abc.xyz/investor/"],
                }
            ),
            "message": {"model": "saved-model"},
        }

    provider = SimpleNamespace(
        name=provider_name, fake=False, model="saved-model", complete=complete
    )
    resolver = OpenCodeWebSearchResolver(
        lambda _: provider, http_client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    result = resolver.resolve("google")
    assert result.company_name == "Alphabet Inc."
    assert result.search_queries == ("GOOGL", "GOOG")
    assert result.provider_model == "saved-model"
    assert len(model_calls) == 2 and len(web_requests) == 1


@pytest.mark.parametrize(
    "calls",
    [
        [],
        [
            {"type": "toolCall", "id": "1", "name": "websearch", "arguments": {"query": "one"}},
            {"type": "toolCall", "id": "2", "name": "websearch", "arguments": {"query": "two"}},
        ],
    ],
)
def test_resolver_does_not_expand_the_tool_loop(calls):
    provider = SimpleNamespace(
        name="deepseek",
        fake=False,
        model="saved-model",
        complete=lambda **kwargs: {"message": {"content": calls}},
    )
    assert OpenCodeWebSearchResolver(lambda _: provider).resolve("google") is None


def test_opencode_resolver_is_optional_when_provider_is_unavailable() -> None:
    resolver = OpenCodeWebSearchResolver(
        lambda _: (_ for _ in ()).throw(
            ProviderRuntimeError("provider_not_configured", "not configured")
        )
    )

    assert resolver.resolve("google") is None
