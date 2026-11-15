"""Compatibility facade for synchronous research and bounded tool requests."""

from __future__ import annotations

import json
import time
from functools import partial

from anyio import run
from pydantic_ai.providers.openai_codex import OpenAICodexCredentialSource

from trading_max.llm import ModelConnection, ProviderError
from trading_max.llm.completion import request_completion
from trading_max.llm.model import _validated_connection

from ..contracts import (
    AnalysisDefinition,
    JsonObject,
    ProviderUsage,
    SynthesisResponse,
    SynthesisResult,
)
from .prompts import _input, _instructions, _response_schema


def decode_json(text: str) -> JsonObject:
    content = text.strip()
    if content.startswith("```"):
        content = "\n".join(content.splitlines()[1:]).removesuffix("```").strip()
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("model JSON output must be an object")
    return value


class ModelProvider:
    """Preserve the synchronous synthesis interface across native provider models."""

    fake = False
    adapter = "pydantic-ai"

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str,
        provider_name: str,
        base_url: str,
        timeout_seconds: float = 180,
        max_attempts: int = 3,
        codex_credentials: OpenAICodexCredentialSource | None = None,
    ) -> None:
        self.connection = ModelConnection(
            provider_name, model, base_url, api_key=api_key, codex_credentials=codex_credentials
        )
        _validated_connection(self.connection)
        self.model, self.name = model, provider_name
        self.timeout_seconds = timeout_seconds
        self.max_retries = max(0, max_attempts - 1)

    def complete(
        self,
        *,
        messages: list[JsonObject],
        system: str = "",
        tools: list[JsonObject] | None = None,
        tool_choice: str | None = None,
        json_output: bool = False,
        schema: JsonObject | None = None,
        max_tokens: int = 12_000,
        temperature: float = 0.1,
        timeout: float | None = None,
    ) -> JsonObject:
        seconds = timeout if timeout is not None else self.timeout_seconds
        return run(
            partial(
                request_completion,
                self.connection,
                messages=messages,
                system=system,
                tools=tools,
                tool_choice=tool_choice,
                json_output=json_output,
                schema=schema,
                max_tokens=max_tokens,
                temperature=temperature,
                timeout_s=seconds,
                max_retries=self.max_retries,
            )
        )

    def json(
        self, *, system: str, user: str, max_tokens: int = 12_000, timeout: float | None = None
    ) -> JsonObject:
        result = self.complete(
            system=system,
            messages=[user_message(user)],
            json_output=True,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        try:
            return decode_json(result["text"])
        except (KeyError, TypeError, ValueError):
            raise ProviderError(provider=self.name, code="provider_invalid_output") from None

    def analyze(self, definition: AnalysisDefinition, context: JsonObject) -> SynthesisResult:
        started = time.perf_counter()
        schema = _response_schema()
        result = self.complete(
            system=_instructions(definition)
            + "\nReturn exactly one JSON object matching this schema:\n"
            + json.dumps(schema, ensure_ascii=False, separators=(",", ":")),
            messages=[user_message(_input(definition, context))],
            json_output=True,
            schema=schema if self.name == "openai" else None,
        )
        try:
            response = SynthesisResponse.model_validate(decode_json(result["text"]))
            usage = result["usage"]
            return SynthesisResult(
                response=response,
                provider=self.name,
                model=self.model,
                usage=ProviderUsage(
                    input_tokens=int(usage.get("input", 0))
                    + int(usage.get("cacheRead", 0))
                    + int(usage.get("cacheWrite", 0)),
                    output_tokens=int(usage.get("output", 0)),
                    total_tokens=int(usage.get("totalTokens", 0)),
                ),
                latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
            )
        except (KeyError, TypeError, ValueError):
            raise ProviderError(provider=self.name, code="provider_invalid_output") from None


def user_message(text: str) -> JsonObject:
    return {"role": "user", "content": text, "timestamp": int(time.time() * 1000)}
