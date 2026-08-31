from __future__ import annotations

import json
from types import SimpleNamespace

import httpx

from services.api.trading_max_api.provider_runtime import ProviderRuntimeError
from services.api.trading_max_api.security_entity_resolution import (
    WEB_SEARCH_MCP_URL,
    OpenCodeWebSearchResolver,
)


def test_opencode_resolver_runs_one_websearch_tool_call() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if str(request.url) == WEB_SEARCH_MCP_URL:
            assert body["method"] == "tools/call"
            assert body["params"]["name"] == "web_search_exa"
            assert (
                "Google publicly traded parent company ticker share classes"
                in (body["params"]["arguments"]["query"])
            )
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "Alphabet Inc. is Google's listed parent. "
                                    "Class A trades as GOOGL and Class C as GOOG. "
                                    "https://abc.xyz/investor/"
                                ),
                            }
                        ]
                    },
                },
            )
        if len([item for item in requests if "chat/completions" in str(item.url)]) == 1:
            assert body["model"] == "deepseek-v4-flash"
            assert body["tool_choice"] == "required"
            assert [item["function"]["name"] for item in body["tools"]] == ["websearch"]
            return httpx.Response(
                200,
                json={
                    "model": "ds-v4-flash-07-31",
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "websearch",
                                            "arguments": json.dumps(
                                                {
                                                    "query": (
                                                        "Google publicly traded parent "
                                                        "company ticker share classes"
                                                    )
                                                }
                                            ),
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                },
            )
        assert body["messages"][-1]["role"] == "tool"
        assert body["messages"][-1]["tool_call_id"] == "call_1"
        assert "Alphabet Inc." in body["messages"][-1]["content"]
        return httpx.Response(
            200,
            json={
                "model": "ds-v4-flash-07-31",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "resolved": True,
                                    "companyName": "Alphabet Inc.",
                                    "searchQueries": ["GOOGL", "GOOG"],
                                    "evidenceUrls": ["https://abc.xyz/investor/"],
                                }
                            ),
                        }
                    }
                ],
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    provider = SimpleNamespace(
        api_key="not-a-secret",
        base_url="https://opencode.ai/zen/go/v1",
        fake=False,
        model="deepseek-v4-flash",
        name="opencode",
    )
    resolver = OpenCodeWebSearchResolver(lambda _: provider, http_client=client)

    result = resolver.resolve("google")

    assert result is not None
    assert result.company_name == "Alphabet Inc."
    assert result.search_queries == ("GOOGL", "GOOG")
    assert result.evidence_urls == ("https://abc.xyz/investor/",)
    assert result.provider_model == "ds-v4-flash-07-31"
    assert len(requests) == 3


def test_opencode_resolver_is_optional_when_provider_is_unavailable() -> None:
    resolver = OpenCodeWebSearchResolver(
        lambda _: (_ for _ in ()).throw(
            ProviderRuntimeError("provider_not_configured", "not configured")
        )
    )

    assert resolver.resolve("google") is None
