"""Trusted LLM provider registry and canonical route parsing.

The dashboard is intentionally not an arbitrary OpenAI-compatible proxy.  The
registry owns the upstream destinations and models that are allowed to receive
portfolio data; only the assistant allows model IDs and loopback URLs outside
the registry defaults.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

LLMProvider = Literal[
    "openai-codex",
    "openai",
    "anthropic",
    "google",
    "opencode",
    "deepseek",
    "openrouter",
    "ollama",
    "lmstudio",
]
ProviderAuth = Literal["api_key", "oauth", "optional_api_key"]

SYNTHESIS_WORKLOADS = ("portfolio", "ticker", "taxonomy")
WORKLOADS = (*SYNTHESIS_WORKLOADS, "assistant")
_ALL_WORKLOADS = frozenset(WORKLOADS)
_ASSISTANT_ONLY = frozenset({"assistant"})
MAX_MODEL_ID_LENGTH = 128
_FREE_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]*(?:/[A-Za-z0-9][A-Za-z0-9_.:-]*)*")


class LLMRouteError(ValueError):
    """Raised when a provider/model route is not trusted or well formed."""


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    provider: LLMProvider
    label: str
    adapter: str
    base_url: str
    models: tuple[str, ...]
    default_model: str | None
    credential_ref: str
    allowed_workloads: frozenset[str]
    legacy: bool = False
    auth_method: ProviderAuth = "api_key"
    legacy_models: tuple[str, ...] = ()
    freeform_models: bool = False
    local: bool = False


@dataclass(frozen=True, slots=True)
class LLMRoute:
    provider: LLMProvider
    model: str

    @property
    def route_id(self) -> str:
        return f"{self.provider}/{self.model}"


PROVIDER_REGISTRY: dict[LLMProvider, ProviderSpec] = {
    "openai": ProviderSpec(
        provider="openai",
        label="OpenAI",
        adapter="pydantic-ai",
        base_url="https://api.openai.com/v1",
        models=("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"),
        default_model="gpt-5.6-luna",
        legacy_models=("gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini"),
        credential_ref="openai:default",
        allowed_workloads=_ALL_WORKLOADS,
    ),
    "openai-codex": ProviderSpec(
        provider="openai-codex",
        label="OpenAI · ChatGPT",
        adapter="pydantic-ai",
        base_url="https://chatgpt.com/backend-api",
        models=("gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"),
        default_model="gpt-5.6-luna",
        credential_ref="openai-codex:default",
        allowed_workloads=_ALL_WORKLOADS,
        auth_method="oauth",
    ),
    "anthropic": ProviderSpec(
        provider="anthropic",
        label="Anthropic",
        adapter="pydantic-ai",
        base_url="https://api.anthropic.com",
        models=("claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-fable-5-1"),
        default_model="claude-haiku-4-5-20251001",
        legacy_models=("claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"),
        credential_ref="anthropic:default",
        allowed_workloads=_ALL_WORKLOADS,
    ),
    "google": ProviderSpec(
        provider="google",
        label="Google",
        adapter="pydantic-ai",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        models=("gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"),
        default_model="gemini-3.8-flash",
        legacy_models=("gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"),
        credential_ref="google:default",
        allowed_workloads=_ALL_WORKLOADS,
    ),
    "opencode": ProviderSpec(
        provider="opencode",
        label="OpenCode",
        adapter="pydantic-ai",
        base_url="https://opencode.ai/zen/go/v1",
        models=("deepseek-v4-flash", "deepseek-v4-pro"),
        default_model="deepseek-v4-flash",
        credential_ref="opencode:default",
        allowed_workloads=_ALL_WORKLOADS,
        legacy=True,
    ),
    "deepseek": ProviderSpec(
        provider="deepseek",
        label="DeepSeek",
        adapter="pydantic-ai",
        base_url="https://api.deepseek.com",
        # Retain old API routes for compatibility, outside the connection picker.
        models=(
            "deepseek-v4-flash",
            "deepseek-v4-pro",
            "deepseek-chat",
            "deepseek-reasoner",
        ),
        default_model="deepseek-v4-flash",
        credential_ref="deepseek:default",
        allowed_workloads=_ALL_WORKLOADS,
        legacy=True,
    ),
    "openrouter": ProviderSpec(
        provider="openrouter",
        label="OpenRouter",
        adapter="pydantic-ai",
        base_url="https://openrouter.ai/api/v1",
        models=(),
        default_model=None,
        credential_ref="openrouter:default",
        allowed_workloads=_ASSISTANT_ONLY,
        freeform_models=True,
    ),
    "ollama": ProviderSpec(
        provider="ollama",
        label="Ollama",
        adapter="pydantic-ai",
        base_url="http://127.0.0.1:11434/v1",
        models=(),
        default_model=None,
        credential_ref="ollama:default",
        allowed_workloads=_ASSISTANT_ONLY,
        auth_method="optional_api_key",
        freeform_models=True,
        local=True,
    ),
    "lmstudio": ProviderSpec(
        provider="lmstudio",
        label="LM Studio",
        adapter="pydantic-ai",
        base_url="http://127.0.0.1:1234/v1",
        models=(),
        default_model=None,
        credential_ref="lmstudio:default",
        allowed_workloads=_ASSISTANT_ONLY,
        auth_method="optional_api_key",
        freeform_models=True,
        local=True,
    ),
}

DEFAULT_ROUTE = "openai/gpt-5.6-luna"


def provider_spec(provider: str) -> ProviderSpec:
    normalized = provider.strip().lower()
    try:
        return PROVIDER_REGISTRY[normalized]  # type: ignore[arg-type]
    except KeyError as exc:
        raise LLMRouteError(f"unknown LLM provider: {provider}") from exc


def validate_model(spec: ProviderSpec, model: str) -> str:
    """Validate a model without normalizing user input."""
    if spec.freeform_models:
        if (
            len(model) <= MAX_MODEL_ID_LENGTH
            and ".." not in model
            and _FREE_MODEL_ID.fullmatch(model)
        ):
            return model
    elif model in (*spec.models, *spec.legacy_models):
        return model
    raise LLMRouteError(f"model is not approved for provider {spec.provider!r}")


def parse_route(
    value: str,
    *,
    default_provider: str = "openai",
    workload: str | None = None,
) -> LLMRoute:
    """Parse ``provider/model`` or a bare model using the default provider."""

    if "/" in value:
        provider, model = value.split("/", 1)
    else:
        provider, model = default_provider, value
    spec = provider_spec(provider)
    if workload is not None and workload not in spec.allowed_workloads:
        raise LLMRouteError(f"provider {spec.provider!r} is not approved for {workload}")
    if not spec.freeform_models:
        model = model.strip()
    return LLMRoute(provider=spec.provider, model=validate_model(spec, model))


def default_route(provider: str) -> LLMRoute:
    spec = provider_spec(provider)
    if spec.default_model is None:
        raise LLMRouteError(f"provider {spec.provider!r} requires a model")
    return LLMRoute(provider=spec.provider, model=spec.default_model)


def _valid_local_url(value: str) -> bool:
    if re.search(r"[\s\x00-\x20\x7f\\?#]", value) or not re.match(
        r"https?://", value, re.IGNORECASE
    ):
        return False
    try:
        url = urlsplit(value)
        return (
            url.port not in (None, 0)
            and re.fullmatch(r"(127\.0\.0\.1|localhost):[0-9]+", url.netloc.lower()) is not None
        )
    except ValueError:
        return False


def provider_base_url(spec: ProviderSpec, value: str | None = None) -> str:
    """Use the pinned HTTPS URL, or a validated override for a loopback provider."""

    if spec.local:
        url = spec.base_url if value is None else value
        if not _valid_local_url(url):
            raise LLMRouteError("base URL must use HTTP(S) and localhost or 127.0.0.1 with a port")
        return url
    if value not in (None, spec.base_url):
        raise LLMRouteError("base URL must match the provider's approved HTTPS URL")
    return spec.base_url


def provider_routes() -> list[dict[str, object]]:
    """Return frontend-safe registry metadata without credentials."""

    return [
        {
            "provider": spec.provider,
            "label": spec.label,
            "adapter": spec.adapter,
            "baseUrl": spec.base_url,
            "models": list(spec.models),
            "defaultModel": spec.default_model,
            "authMethod": spec.auth_method,
        }
        for spec in PROVIDER_REGISTRY.values()
        if not spec.legacy and "portfolio" in spec.allowed_workloads
    ]


__all__ = [
    "DEFAULT_ROUTE",
    "MAX_MODEL_ID_LENGTH",
    "PROVIDER_REGISTRY",
    "SYNTHESIS_WORKLOADS",
    "WORKLOADS",
    "LLMProvider",
    "LLMRoute",
    "LLMRouteError",
    "ProviderAuth",
    "ProviderSpec",
    "default_route",
    "parse_route",
    "provider_base_url",
    "provider_routes",
    "provider_spec",
    "validate_model",
]
