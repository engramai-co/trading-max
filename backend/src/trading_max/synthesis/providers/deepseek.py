"""Shared OpenAI-compatible chat-completions providers.

The provider-specific classes below intentionally share one strict adapter.
Provider identity remains explicit in the result so persisted artifacts and
run provenance can distinguish direct DeepSeek from OpenCode Go routing.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from ..contracts import (
    AnalysisDefinition,
    JsonObject,
    ProviderUsage,
    SynthesisResponse,
    SynthesisResult,
)
from .openai import _input, _instructions, _validate_base_url


class ProviderError(RuntimeError):
    """Stable, secret-free error emitted by a network-backed provider."""

    def __init__(self, *, provider: str, code: str) -> None:
        self.provider = provider
        self.code = code
        super().__init__(f"{provider} provider request failed: {code}")


def _http_error_code(status_code: int) -> str:
    if status_code in {401, 403}:
        return "provider_auth_failed"
    if status_code == 429:
        return "provider_rate_limited"
    if status_code >= 500:
        return "provider_unavailable"
    return "provider_model_rejected"


class OpenAIChatProvider:
    fake = False

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.deepseek.com",
        provider_name: str = "deepseek",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
        http_client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        if not api_key:
            label = {"deepseek": "DeepSeek", "opencode": "OpenCode"}.get(
                provider_name,
                provider_name.title(),
            )
            raise RuntimeError(f"{label} credential is required")
        self.api_key = api_key
        self.model = model
        self.name = provider_name
        self.base_url = _validate_base_url(base_url)
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max(1, max_attempts)
        self._http = http_client
        self._sleep = sleep

    def _decode(self, value: Any) -> JsonObject:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{self.name} response contained empty content")
        content = value.strip()
        if content.startswith("```"):
            lines = content.splitlines()
            lines = lines[1:] if lines and lines[0].startswith("```") else lines
            lines = lines[:-1] if lines and lines[-1].strip() == "```" else lines
            content = "\n".join(lines).strip()
        decoded = json.loads(content)
        if not isinstance(decoded, dict):
            raise ValueError(f"{self.name} JSON output must be an object")
        return decoded

    def analyze(
        self,
        definition: AnalysisDefinition,
        context: JsonObject,
    ) -> SynthesisResult:
        started = time.perf_counter()
        schema = json.dumps(
            SynthesisResponse.model_json_schema(by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        request = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": _instructions(definition)
                    + "\nReturn exactly one JSON object matching this schema:\n"
                    + schema,
                },
                {"role": "user", "content": _input(definition, context)},
            ],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
            "temperature": 0.1,
            "max_tokens": 12_000,
        }
        client = self._http or httpx.Client(timeout=self.timeout_seconds)
        owns_client = self._http is None
        last_error: Exception | None = None
        try:
            for attempt in range(1, self.max_attempts + 1):
                try:
                    response = client.post(
                        f"{self.base_url}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        json=request,
                    )
                    if (
                        response.status_code in {429, 500, 502, 503, 504}
                        and attempt < self.max_attempts
                    ):
                        self._sleep(0.25 * attempt)
                        continue
                    response.raise_for_status()
                    payload = response.json()
                    choices = payload.get("choices") or []
                    if not choices:
                        raise ValueError(f"{self.name} response contained no choices")
                    message = choices[0].get("message") or {}
                    decoded = self._decode(message.get("content"))
                    parsed = SynthesisResponse.model_validate(decoded)
                    usage = payload.get("usage") or {}
                    return SynthesisResult(
                        response=parsed,
                        provider=self.name,
                        model=self.model,
                        usage=ProviderUsage(
                            input_tokens=int(usage.get("prompt_tokens") or 0),
                            output_tokens=int(usage.get("completion_tokens") or 0),
                            total_tokens=int(usage.get("total_tokens") or 0),
                        ),
                        latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
                    )
                except httpx.HTTPStatusError as exc:
                    code = _http_error_code(exc.response.status_code)
                    last_error = exc
                    if (
                        code in {"provider_rate_limited", "provider_unavailable"}
                        and attempt < self.max_attempts
                    ):
                        self._sleep(0.25 * attempt)
                        continue
                    raise ProviderError(provider=self.name, code=code) from exc
                except httpx.TimeoutException as exc:
                    last_error = exc
                    if attempt < self.max_attempts:
                        self._sleep(0.25 * attempt)
                        continue
                    raise ProviderError(
                        provider=self.name,
                        code="provider_unavailable",
                    ) from exc
                except httpx.HTTPError as exc:
                    last_error = exc
                    if attempt < self.max_attempts:
                        self._sleep(0.25 * attempt)
                        continue
                    raise ProviderError(
                        provider=self.name,
                        code="provider_unavailable",
                    ) from exc
                except (KeyError, TypeError, ValueError) as exc:
                    last_error = exc
                    if attempt < self.max_attempts:
                        continue
                    raise ProviderError(
                        provider=self.name,
                        code="provider_invalid_output",
                    ) from exc
        finally:
            if owns_client:
                client.close()
        raise ProviderError(
            provider=self.name,
            code="provider_unavailable",
        ) from last_error


class DeepSeekProvider(OpenAIChatProvider):
    """Direct DeepSeek OpenAI-compatible chat-completions provider."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://api.deepseek.com",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
        http_client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=base_url,
            provider_name="deepseek",
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            http_client=http_client,
            sleep=sleep,
        )


class OpenCodeProvider(OpenAIChatProvider):
    """OpenCode Go provider using its OpenAI-compatible Go endpoint."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = "https://opencode.ai/zen/go/v1",
        timeout_seconds: float = 180,
        max_attempts: int = 3,
        http_client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=base_url,
            provider_name="opencode",
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            http_client=http_client,
            sleep=sleep,
        )
