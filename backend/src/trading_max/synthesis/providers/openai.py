"""Compatibility constructor; OpenAI transport is provided by pi-ai."""

from .pi import PiProvider
from .prompts import _input, _instructions, _response_schema

__all__ = ["OpenAIResponsesProvider", "_input", "_instructions", "_response_schema"]


class OpenAIResponsesProvider(PiProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            provider_name="openai",
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
        )
