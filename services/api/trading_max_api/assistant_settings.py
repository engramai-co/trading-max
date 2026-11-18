"""Shared assistant consent and integration rules."""

from __future__ import annotations

from .llm_routing import LLMRoute, LLMRouteError, parse_route, provider_base_url, provider_spec
from .models import IntegrationSummary

ASSISTANT_CONSENT_REVISION = 2


class AssistantSettingsError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def parse_assistant_route(value: str | None) -> LLMRoute:
    if value is None or "/" not in value:
        raise AssistantSettingsError("provider_route_invalid", "select an assistant provider/model")
    try:
        return parse_route(value, workload="assistant")
    except LLMRouteError:
        raise AssistantSettingsError(
            "provider_route_invalid", "the assistant provider/model is not allowed"
        ) from None


def validate_assistant_integration(
    route: LLMRoute, integration: IntegrationSummary | None
) -> tuple[IntegrationSummary, str]:
    """Resolve a tested integration to its trusted destination."""
    spec = provider_spec(route.provider)
    if (
        integration is None
        or not integration.configured
        or not integration.enabled
        or (
            spec.freeform_models
            and (integration.model != route.model or integration.last_test_status != "succeeded")
        )
    ):
        raise AssistantSettingsError(
            "provider_not_configured", "configure and enable the assistant provider in Settings"
        )
    try:
        return integration, provider_base_url(spec, integration.base_url if spec.local else None)
    except LLMRouteError:
        raise AssistantSettingsError(
            "provider_route_invalid", "the configured assistant base URL is not allowed"
        ) from None
