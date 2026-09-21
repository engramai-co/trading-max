"""Build short-lived, route-aware LLM providers from persisted settings."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from trading_max.synthesis.providers import create_provider

from .config import Settings
from .credentials import CredentialStore, CredentialStoreError
from .llm_routing import (
    DEFAULT_ROUTE,
    PROVIDER_REGISTRY,
    LLMRoute,
    LLMRouteError,
    parse_route,
)
from .settings import SettingsRepository


class ProviderRuntimeError(RuntimeError):
    """Stable, non-secret error raised before a provider request is made."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _annotate_provider(
    provider: Any,
    route: LLMRoute,
    revision: int,
    *,
    adapter: str,
    provider_revision: int | None,
    effective_route: str | None = None,
) -> Any:
    """Attach non-secret provenance used by the analysis control plane."""

    provider.route_id = effective_route or route.route_id
    provider.adapter = adapter
    provider.provider_revision = provider_revision
    provider.route_policy_revision = revision
    return provider


def make_provider_factory(
    settings: Settings,
    preferences: SettingsRepository,
    credentials: CredentialStore,
) -> Callable[[str | None], Any]:
    """Return a provider factory shared by API and dedicated worker processes.

    ``None`` is a non-strict bootstrap lookup used while the app starts; an
    unavailable credential then leaves the health surface usable with the fake
    provider. A workload lookup is strict and fails the actual analysis job
    loudly instead of silently spending a fake result in production.
    """

    def credential_for(route: LLMRoute) -> tuple[str | None, CredentialStoreError | None]:
        spec = PROVIDER_REGISTRY[route.provider]
        integration = preferences.get_integration(route.provider)
        if integration is not None and not integration.enabled:
            return None, None
        try:
            secret = credentials.get(spec.credential_ref)
        except CredentialStoreError as exc:
            secret = None
            credential_error: CredentialStoreError | None = exc
        else:
            credential_error = None
        if not secret:
            secret = {
                "openai": settings.openai_api_key,
                "opencode": settings.opencode_api_key,
                "deepseek": settings.deepseek_api_key,
            }.get(route.provider)
        return secret, credential_error

    def build(workload: str | None = None) -> Any:
        strict = workload is not None
        try:
            route = preferences.get_runtime_route(workload)
        except (RuntimeError, LLMRouteError) as exc:
            if strict:
                raise ProviderRuntimeError(
                    "provider_route_invalid",
                    f"configured LLM route is invalid for {workload}: {exc}",
                ) from exc
            route = parse_route(DEFAULT_ROUTE)
        secret, credential_store_error = credential_for(route)
        spec = PROVIDER_REGISTRY[route.provider]
        integration = preferences.get_integration(route.provider)
        if not secret:
            if settings.llm_provider == "fake":
                return _annotate_provider(
                    create_provider(provider="fake", model="trading-max-fake-v1"),
                    route,
                    preferences.get_route_policy().revision,
                    adapter="fake",
                    provider_revision=None,
                    effective_route="fake/trading-max-fake-v1",
                )
            if strict:
                if credential_store_error is not None:
                    raise ProviderRuntimeError(
                        "credential_store_unavailable",
                        "operating-system credential store is unavailable",
                    ) from credential_store_error
                raise ProviderRuntimeError(
                    "provider_not_configured",
                    f"{route.provider} credential is not configured; configure it in Settings",
                )
            return _annotate_provider(
                create_provider(provider="fake", model="trading-max-fake-v1"),
                route,
                preferences.get_route_policy().revision,
                adapter="fake",
                provider_revision=None,
                effective_route="fake/trading-max-fake-v1",
            )

        provider = create_provider(
            provider=route.provider,
            model=route.model,
            api_key=secret,
            base_url=spec.base_url,
        )
        return _annotate_provider(
            provider,
            route,
            preferences.get_route_policy().revision,
            adapter=spec.adapter,
            provider_revision=integration.revision if integration else None,
        )

    return build


__all__ = ["ProviderRuntimeError", "make_provider_factory"]
