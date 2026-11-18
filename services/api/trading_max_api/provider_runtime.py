"""Build short-lived, route-aware LLM providers from persisted settings."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai import CancellationToken
from pydantic_ai.providers.openai_codex import OpenAICodexCredentialSource
from trading_max.llm import ModelConnection
from trading_max.synthesis.providers import create_provider

from .assistant_settings import (
    ASSISTANT_CONSENT_REVISION,
    AssistantSettingsError,
    parse_assistant_route,
    validate_assistant_integration,
)
from .config import Settings
from .credentials import CredentialStore, CredentialStoreError, secret_fingerprint
from .llm_routing import (
    DEFAULT_ROUTE,
    PROVIDER_REGISTRY,
    LLMProvider,
    LLMRoute,
    LLMRouteError,
    ProviderSpec,
    parse_route,
)
from .models import AssistantPreferences, AssistantReasoning, IntegrationSummary
from .oauth import OAuthCredentialVault
from .settings import SettingsRepository


class ProviderRuntimeError(RuntimeError):
    """Stable, non-secret error raised before a provider request is made."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True, slots=True)
class AssistantConnection:
    provider: LLMProvider
    model: str
    base_url: str
    api_key: str | None = field(repr=False)
    codex_credentials: OpenAICodexCredentialSource | None = field(repr=False)
    reasoning: AssistantReasoning | None
    route_id: str
    provider_revision: int
    preferences_revision: int
    consent_revision: int
    before_request: Callable[[], None] = field(repr=False, compare=False)
    cancellation_token: CancellationToken = field(repr=False, compare=False)

    def to_model_connection(self) -> ModelConnection:
        return ModelConnection(
            provider=self.provider,
            model=self.model,
            base_url=self.base_url,
            api_key=self.api_key,
            codex_credentials=self.codex_credentials,
            before_request=self.before_request,
            cancellation_token=self.cancellation_token,
        )


def assistant_provider_credentials(
    settings: Settings,
    spec: ProviderSpec,
    credentials: CredentialStore,
    fingerprint: str | None,
) -> tuple[str | None, OpenAICodexCredentialSource | None]:
    """Read an API key or obtain the credential source for a stored OAuth connection."""
    try:
        key = credentials.get(spec.credential_ref)
    except CredentialStoreError:
        raise ProviderRuntimeError(
            "credential_store_unavailable",
            "operating-system credential store is unavailable",
        ) from None
    if key is None or not key.strip():
        raise ProviderRuntimeError(
            "provider_not_configured",
            "configure the assistant provider in Settings",
        )
    if spec.auth_method != "oauth":
        if secret_fingerprint(key) != fingerprint:
            raise ProviderRuntimeError(
                "assistant_settings_changed", "the saved key does not match the selected connection"
            )
        return key, None
    # OAuth grants rotate independently of integration metadata at the provider's pinned origin.
    try:
        return None, OAuthCredentialVault(settings.data_root, credentials).credential_source()
    except CredentialStoreError:
        raise ProviderRuntimeError(
            "credential_store_unavailable",
            "operating-system credential store is unavailable",
        ) from None
    except (OSError, KeyError, TypeError, ValueError):
        raise ProviderRuntimeError(
            "provider_auth_failed", "the assistant provider authorization failed"
        ) from None


def _consented_assistant_route(
    preferences: SettingsRepository, requested_route: str | None, *, background: bool = False
) -> tuple[AssistantPreferences, LLMRoute, IntegrationSummary, str, CancellationToken]:
    current, integration, access = preferences.assistant_connection_snapshot(background=background)
    if not current.enabled or (background and not current.background_briefs_enabled):
        raise ProviderRuntimeError("assistant_disabled", "enable the assistant in Settings")
    if current.accepted_consent_revision != ASSISTANT_CONSENT_REVISION:
        raise ProviderRuntimeError(
            "assistant_consent_required", "accept the current assistant consent revision"
        )
    try:
        route = parse_assistant_route(current.route)
        integration, base_url = validate_assistant_integration(route, integration)
    except AssistantSettingsError as exc:
        raise ProviderRuntimeError(exc.code, str(exc)) from None
    if current.accepted_destination != base_url or (
        requested_route is not None and route.route_id != requested_route
    ):
        raise ProviderRuntimeError(
            "assistant_consent_required", "review the selected assistant destination"
        )
    return current, route, integration, base_url, access


def resolve_assistant_connection(
    settings: Settings,
    preferences: SettingsRepository,
    credentials: CredentialStore,
    *,
    requested_route: str | None = None,
    background: bool = False,
) -> AssistantConnection:
    """Resolve the selected, consented assistant route using OS credentials.

    Run in a worker thread: the credential manager is synchronous.
    """
    current, route, integration, base_url, access = _consented_assistant_route(
        preferences, requested_route, background=background
    )

    def before_request() -> None:
        try:
            enabled, consent, revision, integration_revision, background_enabled = (
                preferences.assistant_dispatch_state(integration.integration_id)
            )
        except sqlite3.Error:
            raise ProviderRuntimeError(
                "assistant_settings_changed", "the current assistant settings could not be verified"
            ) from None
        if not enabled or (background and not background_enabled):
            raise ProviderRuntimeError("assistant_disabled", "enable the assistant in Settings")
        if (
            consent != ASSISTANT_CONSENT_REVISION
            or revision != current.revision
            or integration_revision != integration.revision
            or access.cancelled
        ):
            raise ProviderRuntimeError(
                "assistant_settings_changed", "start a new turn with the current settings"
            )

    spec = PROVIDER_REGISTRY[route.provider]
    # A credential lookup can block while another request changes the endpoint.
    before_request()
    key, codex_credentials = (
        (None, None)
        if spec.auth_method == "optional_api_key" and not integration.credential_fingerprint
        else assistant_provider_credentials(
            settings, spec, credentials, integration.credential_fingerprint
        )
    )
    before_request()
    return AssistantConnection(
        provider=route.provider,
        model=route.model,
        base_url=base_url,
        api_key=key,
        codex_credentials=codex_credentials,
        reasoning=current.reasoning,
        route_id=route.route_id,
        provider_revision=integration.revision,
        preferences_revision=current.revision,
        consent_revision=ASSISTANT_CONSENT_REVISION,
        before_request=before_request,
        cancellation_token=access,
    )


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

        if route.provider == "openai-codex":
            provider = OAuthCredentialVault(settings.data_root, credentials).provider(route.model)
        else:
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


__all__ = [
    "ASSISTANT_CONSENT_REVISION",
    "AssistantConnection",
    "ProviderRuntimeError",
    "assistant_provider_credentials",
    "make_provider_factory",
    "resolve_assistant_connection",
]
