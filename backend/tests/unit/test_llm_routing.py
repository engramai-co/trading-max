from __future__ import annotations

import pytest

from services.api.trading_max_api.llm_routing import (
    LLMRouteError,
    parse_route,
    provider_routes,
)


def test_routes_are_explicit_and_provider_scoped() -> None:
    assert parse_route("opencode/deepseek-v4-flash").route_id == ("opencode/deepseek-v4-flash")
    assert parse_route("deepseek/deepseek-chat").route_id == "deepseek/deepseek-chat"
    with pytest.raises(LLMRouteError, match="not approved"):
        parse_route("deepseek-chat")


def test_route_parser_rejects_unknown_provider_and_model() -> None:
    with pytest.raises(LLMRouteError, match="unknown LLM provider"):
        parse_route("openrouter/some-model")
    with pytest.raises(LLMRouteError, match="not approved"):
        parse_route("deepseek/deepseek-v4-flash")


def test_provider_registry_is_safe_frontend_metadata() -> None:
    routes = provider_routes()
    assert {item["provider"] for item in routes} == {"opencode", "deepseek"}
    assert all("api_key" not in item and "secret" not in item for item in routes)
