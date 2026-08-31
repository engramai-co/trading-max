"""Network and fake LLM provider implementations."""

from __future__ import annotations

from .deepseek import (
    DeepSeekProvider,
    OpenAIChatProvider,
    OpenCodeProvider,
    ProviderError,
)
from .fake import FakeProvider
from .openai import OpenAIResponsesProvider


def create_provider(
    *,
    provider: str,
    model: str,
    openai_api_key: str | None = None,
    openai_base_url: str = "https://api.openai.com/v1",
    deepseek_api_key: str | None = None,
    deepseek_base_url: str = "https://api.deepseek.com",
    opencode_api_key: str | None = None,
    opencode_base_url: str = "https://opencode.ai/zen/go/v1",
):
    normalized = provider.strip().lower()
    if normalized == "fake":
        return FakeProvider()
    if normalized == "openai":
        return OpenAIResponsesProvider(
            api_key=openai_api_key or "",
            model=model,
            base_url=openai_base_url,
        )
    if normalized == "deepseek":
        return DeepSeekProvider(
            api_key=deepseek_api_key or "",
            model=model,
            base_url=deepseek_base_url,
        )
    if normalized == "opencode":
        return OpenCodeProvider(
            api_key=opencode_api_key or "",
            model=model,
            base_url=opencode_base_url,
        )
    raise ValueError(f"unsupported LLM provider: {provider}")


__all__ = [
    "DeepSeekProvider",
    "FakeProvider",
    "OpenAIChatProvider",
    "OpenAIResponsesProvider",
    "OpenCodeProvider",
    "ProviderError",
    "create_provider",
]
