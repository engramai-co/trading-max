"""A narrow Python/Pi boundary; all model HTTP behavior belongs to pi-ai."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from ..contracts import (
    AnalysisDefinition,
    JsonObject,
    ProviderUsage,
    SynthesisResponse,
    SynthesisResult,
)
from .prompts import _input, _instructions, _response_schema

PI_ROOT = Path(__file__).resolve().parents[1] / "_pi"
ERROR_CODES = {
    "provider_not_configured",
    "provider_auth_failed",
    "provider_rate_limited",
    "provider_model_rejected",
    "provider_unavailable",
    "provider_invalid_output",
    "provider_runtime_unavailable",
}


class ProviderError(RuntimeError):
    """Stable error without upstream response text or child-process diagnostics."""

    def __init__(self, *, provider: str, code: str) -> None:
        self.provider = provider
        self.code = code if code in ERROR_CODES else "provider_unavailable"
        super().__init__(f"{provider} provider request failed: {self.code}")


def _validate_base_url(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("LLM base URL must be HTTPS without credentials or query parameters")
    return value.rstrip("/")


def _node() -> str:
    # Production pins Node next to its release; foreground development uses PATH.
    for parent in Path(__file__).resolve().parents:
        pinned = parent / ".node-runtime" / "node"
        if pinned.is_file():
            return str(pinned)
    return shutil.which("node") or "node"


def _invoke(request: JsonObject, timeout: float) -> JsonObject:
    provider = str(request["provider"])
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "PATH",
            "LANG",
            "LC_ALL",
            "TZ",
            "SYSTEMROOT",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
        }
    }
    try:
        # Executable and script are trusted local paths; all request data is stdin.
        result = subprocess.run(  # noqa: S603
            [_node(), str(PI_ROOT / "index.mjs")],
            input=json.dumps(request, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=timeout + 5,
            env=environment,
            check=False,
        )
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ValueError("invalid Pi response")
        code = payload.get("error")
        if code or result.returncode:
            raise ProviderError(provider=provider, code=str(code or "provider_runtime_unavailable"))
        return payload
    except subprocess.TimeoutExpired:
        raise ProviderError(provider=provider, code="provider_unavailable") from None
    except (OSError, ValueError):
        raise ProviderError(provider=provider, code="provider_runtime_unavailable") from None


def decode_json(text: str) -> JsonObject:
    content = text.strip()
    if content.startswith("```"):
        content = "\n".join(content.splitlines()[1:]).removesuffix("```").strip()
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("model JSON output must be an object")
    return value


class PiProvider:
    """Preserve domain results and saved provider identity around the Pi SDK."""

    fake = False

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        provider_name: str,
        base_url: str,
        timeout_seconds: float = 180,
        max_attempts: int = 3,
    ) -> None:
        if not api_key:
            raise RuntimeError(f"{provider_name} credential is required")
        self.api_key, self.model, self.name = api_key, model, provider_name
        self.base_url = _validate_base_url(base_url)
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
        return _invoke(
            {
                "provider": self.name,
                "model": self.model,
                "baseUrl": self.base_url,
                "apiKey": self.api_key,
                "context": {"systemPrompt": system, "messages": messages, "tools": tools or []},
                "toolChoice": tool_choice,
                "json": json_output,
                "schema": schema,
                "maxTokens": max_tokens,
                "temperature": temperature,
                "timeoutMs": max(1, int(seconds * 1000)),
                "maxRetries": self.max_retries,
            },
            seconds,
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
