"""Trusted LLM provider registry and canonical route parsing.

The dashboard is intentionally not an arbitrary OpenAI-compatible proxy.  The
registry owns the upstream destinations and models that are allowed to receive
portfolio data; callers select a provider/model route, never a free-form URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

LLMProvider = Literal["opencode", "deepseek"]


class LLMRouteError(ValueError):
    """Raised when a provider/model route is not trusted or well formed."""


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    """Wire-level behavior required by the shared chat-completions adapter."""

    json_object: bool = True
    disable_thinking: bool = True
    reasoning_content: bool = True


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    provider: LLMProvider
    label: str
    adapter: str
    base_url: str
    models: tuple[str, ...]
    default_model: str
    credential_ref: str
    capabilities: ProviderCapabilities = ProviderCapabilities()


@dataclass(frozen=True, slots=True)
class LLMRoute:
    provider: LLMProvider
    model: str

    @property
    def route_id(self) -> str:
        return f"{self.provider}/{self.model}"


PROVIDER_REGISTRY: dict[LLMProvider, ProviderSpec] = {
    "opencode": ProviderSpec(
        provider="opencode",
        label="OpenCode",
        adapter="openai-chat",
        base_url="https://opencode.ai/zen/go/v1",
        models=("deepseek-v4-flash", "deepseek-v4-pro"),
        default_model="deepseek-v4-flash",
        credential_ref="opencode:default",
    ),
    "deepseek": ProviderSpec(
        provider="deepseek",
        label="DeepSeek",
        adapter="openai-chat",
        base_url="https://api.deepseek.com",
        # Keep the legacy aliases valid for existing installations while
        # offering the current direct-API models to new connections.
        models=(
            "deepseek-v4-flash",
            "deepseek-v4-pro",
            "deepseek-chat",
            "deepseek-reasoner",
        ),
        default_model="deepseek-v4-flash",
        credential_ref="deepseek:default",
    ),
}

DEFAULT_ROUTE = "opencode/deepseek-v4-flash"
WORKLOADS = ("portfolio", "ticker", "taxonomy")


def provider_spec(provider: str) -> ProviderSpec:
    normalized = provider.strip().lower()
    try:
        return PROVIDER_REGISTRY[normalized]  # type: ignore[arg-type]
    except KeyError as exc:
        raise LLMRouteError(f"unknown LLM provider: {provider}") from exc


def parse_route(value: str, *, default_provider: str = "opencode") -> LLMRoute:
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
    ]


__all__ = [
    "DEFAULT_ROUTE",
    "PROVIDER_REGISTRY",
    "WORKLOADS",
    "LLMProvider",
    "LLMRoute",
    "LLMRouteError",
    "ProviderCapabilities",
    "ProviderSpec",
    "default_route",
    "parse_route",
    "provider_routes",
    "provider_spec",
]
