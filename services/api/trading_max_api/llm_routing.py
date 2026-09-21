"""Trusted LLM provider registry and canonical route parsing.

The dashboard is intentionally not an arbitrary OpenAI-compatible proxy.  The
registry owns the upstream destinations and models that are allowed to receive
portfolio data; callers select a provider/model route, never a free-form URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

LLMProvider = Literal["openai", "anthropic", "google", "opencode", "deepseek"]


class LLMRouteError(ValueError):
    """Raised when a provider/model route is not trusted or well formed."""


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    provider: LLMProvider
    label: str
    adapter: str
    base_url: str
    models: tuple[str, ...]
    default_model: str
    credential_ref: str
    legacy: bool = False


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
        adapter="pi-ai",
        base_url="https://api.openai.com/v1",
        models=("gpt-5.4-mini", "gpt-5.4", "gpt-4.1-mini"),
        default_model="gpt-5.4-mini",
        credential_ref="openai:default",
    ),
    "anthropic": ProviderSpec(
        provider="anthropic",
        label="Anthropic",
        adapter="pi-ai",
        base_url="https://api.anthropic.com",
        models=("claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"),
        default_model="claude-sonnet-4-6",
        credential_ref="anthropic:default",
    ),
    "google": ProviderSpec(
        provider="google",
        label="Google",
        adapter="pi-ai",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        models=("gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"),
        default_model="gemini-2.5-flash",
        credential_ref="google:default",
    ),
    "opencode": ProviderSpec(
        provider="opencode",
        label="OpenCode",
        adapter="pi-ai",
        base_url="https://opencode.ai/zen/go/v1",
        models=("deepseek-v4-flash", "deepseek-v4-pro"),
        default_model="deepseek-v4-flash",
        credential_ref="opencode:default",
        legacy=True,
    ),
    "deepseek": ProviderSpec(
        provider="deepseek",
        label="DeepSeek",
        adapter="pi-ai",
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
        legacy=True,
    ),
}

DEFAULT_ROUTE = "openai/gpt-5.4-mini"
WORKLOADS = ("portfolio", "ticker", "taxonomy")


def provider_spec(provider: str) -> ProviderSpec:
    normalized = provider.strip().lower()
    try:
        return PROVIDER_REGISTRY[normalized]  # type: ignore[arg-type]
    except KeyError as exc:
        raise LLMRouteError(f"unknown LLM provider: {provider}") from exc


def parse_route(value: str, *, default_provider: str = "openai") -> LLMRoute:
    """Parse ``provider/model`` or a bare model using the default provider."""

    text = value.strip()
    if not text:
        raise LLMRouteError("LLM route cannot be empty")
    if "/" in text:
        provider, model = text.split("/", 1)
    else:
        provider, model = default_provider, text
    spec = provider_spec(provider)
    model = model.strip()
    if not model:
        raise LLMRouteError("LLM route model cannot be empty")
    if model not in spec.models:
        raise LLMRouteError(f"model {model!r} is not approved for provider {spec.provider!r}")
    return LLMRoute(provider=spec.provider, model=model)


def default_route(provider: str) -> LLMRoute:
    spec = provider_spec(provider)
    return LLMRoute(provider=spec.provider, model=spec.default_model)


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
        }
        for spec in PROVIDER_REGISTRY.values()
        if not spec.legacy
    ]


__all__ = [
    "DEFAULT_ROUTE",
    "PROVIDER_REGISTRY",
    "WORKLOADS",
    "LLMProvider",
    "LLMRoute",
    "LLMRouteError",
    "ProviderSpec",
    "default_route",
    "parse_route",
    "provider_routes",
    "provider_spec",
]
