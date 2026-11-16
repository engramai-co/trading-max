"""Compatibility constructors; all model transport is provided by Pydantic AI."""

from .model import ModelProvider, ProviderError

__all__ = ["DeepSeekProvider", "OpenAIChatProvider", "OpenCodeProvider", "ProviderError"]
OpenAIChatProvider = ModelProvider


class DeepSeekProvider(ModelProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.deepseek.com",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            provider_name="deepseek",
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
        )


class OpenCodeProvider(ModelProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://opencode.ai/zen/go/v1",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            provider_name="opencode",
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
        )
