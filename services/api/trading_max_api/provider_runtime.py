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
    default_route,
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


def _legacy_opencode_migration(
    preferences: SettingsRepository,
    credentials: CredentialStore,
) -> None:
    """Move the old OpenCode-as-DeepSeek record once, without exposing its key."""

    legacy = preferences.get_integration("deepseek")
    if (
        legacy is None
        or not legacy.configured
        or not legacy.base_url
        or not legacy.base_url.startswith("https://opencode.ai/zen/go/v1")
        or preferences.get_integration("opencode") is not None
    ):
        return
    try:
        secret = credentials.get(preferences.credential_reference("deepseek"))
    except CredentialStoreError:
        # Importing the API on Linux/CI must not require the native keychain.
        # The migration can retry on the real host when the provider is used.
        return
    if not secret:
        return
    spec = PROVIDER_REGISTRY["opencode"]
    model = legacy.model if legacy.model in spec.models else spec.default_model
    credentials.put(preferences.credential_reference("opencode"), secret)
    preferences.save_integration(
        provider="opencode",
        profile=None,
        enabled=legacy.enabled,
        model=model,
        base_url=spec.base_url,
        credential_fingerprint=legacy.credential_fingerprint,
        test_status=legacy.last_test_status,
        error_code=legacy.last_error_code,
        actor="migration",
    )
    credentials.delete(preferences.credential_reference("deepseek"))
    preferences.remove_integration(provider="deepseek", profile=None, actor="migration")


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

    _legacy_opencode_migration(preferences, credentials)

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
            secret = (
                settings.opencode_api_key
                if route.provider == "opencode"
                else settings.deepseek_api_key
            )
        return secret, credential_error

    def available_route(
        preferred: LLMRoute,
    ) -> tuple[LLMRoute, str | None, CredentialStoreError | None]:
        """Use the preferred route, then the other configured approved provider.

        This fallback happens before any provider request. It avoids making an
        optional model look required when a user configured only one of the two
        supported services, without silently duplicating a failed paid request.
        """

        candidates = [preferred]
        for provider in PROVIDER_REGISTRY:
            if provider == preferred.provider:
                continue
            integration = preferences.get_integration(provider)
            model = (
                integration.model
                if integration is not None
                and integration.model in PROVIDER_REGISTRY[provider].models
                else None
            )
            candidates.append(
                LLMRoute(
                    provider=provider,
                    model=model or default_route(provider).model,
                )
            )

        credential_error: CredentialStoreError | None = None
        for route in candidates:
            secret, error = credential_for(route)
            credential_error = credential_error or error
            if secret:
                return route, secret, credential_error
        return preferred, None, credential_error

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
        route, secret, credential_store_error = available_route(route)
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

        if route.provider == "opencode":
            provider = create_provider(
                provider="opencode",
                model=route.model,
                opencode_api_key=secret,
                opencode_base_url=spec.base_url,
            )
        else:
            provider = create_provider(
                provider="deepseek",
                model=route.model,
                deepseek_api_key=secret,
                deepseek_base_url=spec.base_url,
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
