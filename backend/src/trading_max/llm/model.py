"""Build native Pydantic AI models with explicit credentials and a pinned HTTP boundary."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from math import isfinite
from types import MappingProxyType
from typing import Annotated, Any
from urllib.parse import urlsplit

import anyio
import httpx2
from anthropic import AsyncAnthropic
from google.genai import Client as GenAIClient
from google.genai.types import HttpOptions, HttpRetryOptions
from openai import AsyncOpenAI
from pydantic import Field, TypeAdapter
from pydantic_ai.exceptions import ModelHTTPError, UserError
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.openai_codex import OpenAICodexModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.providers._oauth_provider import jwt_claims, jwt_expires_at
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openai_codex import (
    CredentialsPersistenceError,
    CredentialsRefreshError,
    OpenAICodexCredentials,
    OpenAICodexCredentialSource,
    OpenAICodexProvider,
)
from pydantic_ai.providers.openrouter import OpenRouterProvider
from pydantic_ai.retries import AsyncHTTPX2TenacityTransport, RetryConfig, wait_retry_after
from tenacity import retry_if_exception_type, stop_after_attempt, stop_any, wait_exponential

REMOTE_BASE_URLS = MappingProxyType(
    {
        "openai": "https://api.openai.com/v1",
        "openai-codex": "https://chatgpt.com/backend-api",
        "anthropic": "https://api.anthropic.com",
        "google": "https://generativelanguage.googleapis.com/v1beta",
        "deepseek": "https://api.deepseek.com",
        "opencode": "https://opencode.ai/zen/go/v1",
        "openrouter": "https://openrouter.ai/api/v1",
    }
)
LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio"})
_ERROR_CODES = frozenset(
    {
        "provider_not_configured",
        "provider_auth_failed",
        "provider_rate_limited",
        "provider_model_rejected",
        "provider_unavailable",
        "provider_invalid_output",
        "provider_runtime_unavailable",
    }
)
_SAFE_PROVIDER_NAMES = REMOTE_BASE_URLS.keys() | LOCAL_PROVIDERS
_CODEX_GRANT_URL = "https://auth.openai.com/oauth/token"
_TOKEN_TTL: ContextVar[float | None] = ContextVar("trading_max_codex_ttl", default=None)


@dataclass
class _AccountClaim:
    chatgpt_account_id: str | None = None


@dataclass
class _AccessClaims:
    auth: Annotated[_AccountClaim | None, Field(validation_alias="https://api.openai.com/auth")] = (
        None
    )


_ACCESS_CLAIMS = TypeAdapter(_AccessClaims)


@dataclass
class TimedCodexCredentials(OpenAICodexCredentials):
    """Codex credentials with the expiry retained by Trading Max's keychain format."""

    expires_ms: float = field(kw_only=True, compare=False)


async def _capture_grant_expiry(response: httpx2.Response) -> None:
    if response.request.url == _CODEX_GRANT_URL and response.status_code == 200:
        await response.aread()
        try:
            value = response.json().get("expires_in")
            if isinstance(value, (float, int)) and isfinite(value) and value > 0:
                _TOKEN_TTL.set(value)
        except (AttributeError, OverflowError, ValueError):
            pass


class ProviderError(RuntimeError):
    """A stable error that never includes upstream messages or request data."""

    def __init__(self, *, provider: str, code: str) -> None:
        self.provider = provider if provider in _SAFE_PROVIDER_NAMES else "unknown"
        self.code = code if code in _ERROR_CODES else "provider_unavailable"
        super().__init__(f"{self.provider} provider request failed: {self.code}")


@dataclass(frozen=True, slots=True)
class ModelConnection:
    """An explicit model route and its separately supplied credential."""

    provider: str
    model: str
    base_url: str
    api_key: str | None = field(default=None, repr=False)
    codex_credentials: OpenAICodexCredentialSource | None = field(default=None, repr=False)
    before_request: Callable[[], None] | None = field(default=None, repr=False, compare=False)


def _validated_connection(connection: ModelConnection) -> str:
    provider = connection.provider
    base_url = connection.base_url
    if provider in LOCAL_PROVIDERS:
        try:
            local = urlsplit(base_url)
            trusted = (
                not re.search(r"[\s\x00-\x20\x7f\\?#]", base_url)
                and local.scheme in {"http", "https"}
                and bool(re.fullmatch(r"(127\.0\.0\.1|localhost):[0-9]+", local.netloc, re.I))
                and local.port not in (None, 0)
            )
        except ValueError:
            trusted = False
    else:
        trusted = provider in REMOTE_BASE_URLS and REMOTE_BASE_URLS[provider] == base_url
    if not trusted:
        raise ProviderError(provider=provider, code="provider_model_rejected")
    if (
        not connection.model
        or not connection.model.strip()
        or any(c in connection.model for c in ("..", "?", "#", "\\", "%"))
        or any(c.isspace() or ord(c) < 32 for c in connection.model)
    ):
        raise ProviderError(provider=provider, code="provider_model_rejected")
    if provider == "openai-codex":
        configured = connection.codex_credentials is not None
    else:
        configured = bool(connection.api_key and connection.api_key.strip())
    if not configured and provider not in LOCAL_PROVIDERS:
        raise ProviderError(provider=provider, code="provider_not_configured")
    return base_url.rstrip("/")


def _validate_retryable(response: httpx2.Response) -> None:
    status = response.status_code
    if response.headers.get("x-should-retry", "").lower() != "false" and (
        status in (408, 409, 429) or 500 <= status < 600
    ):
        response.raise_for_status()


def _base_transport() -> httpx2.AsyncBaseTransport:
    return httpx2.AsyncHTTPTransport(trust_env=False)


class _CheckedTransport(httpx2.AsyncBaseTransport):
    """Check current authorisation before each wire attempt, including retries and OAuth refresh."""

    def __init__(self, transport: httpx2.AsyncBaseTransport, check: Callable[[], None]):
        self.transport = transport
        self.check = check

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        await anyio.to_thread.run_sync(self.check)
        return await self.transport.handle_async_request(request)

    async def aclose(self) -> None:
        await self.transport.aclose()


class _ModelTransport(httpx2.AsyncBaseTransport):
    def __init__(
        self,
        base_url: str,
        *,
        provider: str,
        no_key: bool,
        max_retries: int,
        before_request: Callable[[], None] | None = None,
    ) -> None:
        self._endpoint = httpx2.URL(base_url)
        self._provider = provider
        self._no_key = no_key
        self._transport = _base_transport()
        if before_request is not None:
            self._transport = _CheckedTransport(self._transport, before_request)
        attempts = 1 + max(0, min(max_retries, 2))
        self._retrying = AsyncHTTPX2TenacityTransport(
            RetryConfig(
                retry=retry_if_exception_type((httpx2.TransportError, httpx2.HTTPStatusError)),
                wait=wait_retry_after(
                    fallback_strategy=wait_exponential(multiplier=0.5, max=10),
                    max_wait=float("inf"),
                ),
                stop=stop_any(
                    stop_after_attempt(attempts), lambda state: state.upcoming_sleep > 10
                ),
                reraise=True,
            ),
            wrapped=self._transport,
            validate_response=_validate_retryable if attempts > 1 else None,
        )

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        url = request.url
        refresh = self._provider == "openai-codex" and url == _CODEX_GRANT_URL
        origin = (url.scheme, url.host, url.port)
        expected = (self._endpoint.scheme, self._endpoint.host, self._endpoint.port)
        prefix = self._endpoint.path.rstrip("/")
        if not refresh and (
            origin != expected or (prefix and not url.path.startswith(f"{prefix}/"))
        ):
            raise httpx2.UnsupportedProtocol("model endpoint does not match the approved origin")
        if self._no_key or self._provider == "anthropic":
            request.headers.pop("authorization", None)
        # Do not inherit OpenAI SDK organization/project routing from the environment.
        for header in ("openai-organization", "openai-project"):
            request.headers.pop(header, None)
        if self._provider == "openai-codex":
            for header in ("session-id", "thread-id", "x-client-request-id"):
                request.headers.pop(header, None)

        # The framework retries only opening a response. It does not consume
        # a successful SSE stream, and the single-use OAuth grant bypasses it.
        if refresh:
            return await self._transport.handle_async_request(request)
        try:
            return await self._retrying.handle_async_request(request)
        except httpx2.HTTPStatusError as exc:
            # The retry framework closes rejected responses before retrying.
            # Give the SDK a status response without reopening its body or
            # carrying upstream diagnostics across the product boundary.
            return httpx2.Response(
                exc.response.status_code,
                json={"error": {"message": "model request rejected"}},
                headers={
                    name: exc.response.headers[name]
                    for name in ("retry-after", "retry-after-ms")
                    if name in exc.response.headers
                },
            )

    async def aclose(self) -> None:
        await self._transport.aclose()


class _OpenRouterProvider(OpenRouterProvider):
    @staticmethod
    def model_profile(model_name: str):
        # Profiles are optional hints. Let the gateway resolve a saved alias
        # even if the SDK cannot infer a provider prefix from the alias itself.
        return OpenRouterProvider.model_profile(
            model_name if "/" in model_name else f"unlisted/{model_name}"
        )


class _ResponsesModel(OpenAIResponsesModel):
    def _build_include(self, model_settings, *, is_retrieve=False):
        include = super()._build_include(model_settings, is_retrieve=is_retrieve)
        if model_settings.get("openai_reasoning_effort") == "none":
            return [value for value in include if value != "reasoning.encrypted_content"]
        return include


class _DeepSeekChatModel(OpenAIChatModel):
    def _map_model_response(self, message):
        mapped = super()._map_model_response(message)
        if mapped and mapped.get("tool_calls"):
            mapped.setdefault("reasoning_content", "")
        return mapped


class _CodexModel(OpenAICodexModel):
    def _prepare_responses_settings(self, messages, model_settings):
        # Agent histories contain a conversation ID. Codex uses it for cache
        # affinity by default; Trading Max sends complete, independent requests.
        return model_settings


class _CodexProvider(OpenAICodexProvider):
    def _is_stale(self) -> bool:
        if isinstance(self.credentials, TimedCodexCredentials):
            return datetime.now(UTC).timestamp() * 1000 >= self.credentials.expires_ms
        return super()._is_stale()

    async def _refresh_if_stale(self) -> None:
        # Legacy login refresh fails before inference rather than spending a
        # request with an expired key if the grant fails.
        if self._is_stale():
            async with self._refresh_lock:
                if self._is_stale():
                    await self._refresh_locked()

    async def _refresh_for_401(self, revision_used: int, *, refresh_failures: int) -> None:
        # Pi refreshed on expiry only. A rejected live credential reports an
        # auth failure without replaying the prompt or spending its refresh token.
        raise ProviderError(provider=self.name, code="provider_auth_failed")

    async def _refresh_grant(
        self, credentials: OpenAICodexCredentials, http_client: httpx2.AsyncClient
    ) -> OpenAICodexCredentials:
        token = _TOKEN_TTL.set(None)
        try:
            refreshed = await super()._refresh_grant(credentials, http_client)
            if (ttl := _TOKEN_TTL.get()) is not None:
                expires = (datetime.now(UTC).timestamp() + ttl) * 1000
            elif (jwt_exp := jwt_expires_at(refreshed.access_token)) is not None:
                expires = jwt_exp.timestamp() * 1000
            else:
                raise ProviderError(provider=self.name, code="provider_auth_failed")
            # Device-flow responses carry the account on the access JWT.
            # This is routing metadata, not a signature/authentication check.
            claims = jwt_claims(refreshed.access_token, _ACCESS_CLAIMS)
            account_id = claims.auth.chatgpt_account_id if claims and claims.auth else None
            return TimedCodexCredentials(
                access_token=refreshed.access_token,
                refresh_token=refreshed.refresh_token,
                account_id=account_id or refreshed.account_id,
                expires_ms=expires,
            )
        finally:
            _TOKEN_TTL.reset(token)

    async def _refresh_locked(self) -> None:
        source = self._credential_source
        if (lock := getattr(source, "refresh_lock", None)) is None:
            await super()._refresh_locked()
            return
        # The SDK's process-local lock cannot serialize the read/grant/save
        # transaction across the API and worker. Re-read the store inside its lock.
        async with lock():
            await super()._refresh_locked()


def _make_model(
    connection: ModelConnection,
    base_url: str,
    make_client: Callable[[], httpx2.AsyncClient],
    *,
    timeout_s: float,
) -> Model:
    client = make_client()
    name = connection.provider
    key = connection.api_key
    if key and not key.strip():
        key = None
    model_name = connection.model
    if name == "openai-codex":
        provider = _CodexProvider(
            credential_source=connection.codex_credentials, http_client=client
        )
        provider.client.max_retries = 0
        model = _CodexModel(
            model_name,
            provider=provider,
            settings={"openai_store": False, "openai_transport": "http"},
        )
    elif name == "anthropic":
        provider = AnthropicProvider(
            anthropic_client=AsyncAnthropic(
                api_key=key,
                base_url=base_url,
                max_retries=0,
                http_client=client,
                default_headers={"x-api-key": key},
                default_query={"beta": "true"},
            )
        )
        model = AnthropicModel(
            model_name,
            provider=provider,
            profile={"anthropic_disallows_sampling_settings": False}
            if model_name.startswith("claude-sonnet-5")
            and not model_name.startswith("claude-sonnet-5.")
            else None,
        )
    elif name == "google":
        origin, _, api_version = base_url.rpartition("/")
        provider = GoogleProvider(
            client=GenAIClient(
                vertexai=False,
                api_key=key,
                http_options=HttpOptions(
                    base_url=origin,
                    api_version=api_version,
                    timeout=max(1, int(timeout_s * 1000)),
                    httpx_async_client=client,
                    retry_options=HttpRetryOptions(attempts=1),
                    client_args={"follow_redirects": False, "trust_env": False},
                    async_client_args={"follow_redirects": False, "trust_env": False},
                ),
            )
        )
        model = GoogleModel(model_name, provider=provider)
    else:
        sdk = AsyncOpenAI(
            base_url=base_url,
            api_key=key or "api-key-not-set",
            max_retries=0,
            http_client=client,
        )
        if name == "openrouter":
            provider = _OpenRouterProvider(openai_client=sdk)
            model = OpenRouterModel(model_name, provider=provider)
        elif name == "openai":
            provider = OpenAIProvider(openai_client=sdk)
            model = _ResponsesModel(
                model_name,
                provider=provider,
                settings={"openai_store": False, "openai_transport": "http"},
                profile={
                    "openai_system_prompt_role": "developer",
                    "openai_supports_reasoning_effort_none": True,
                }
                if model_name.startswith(("gpt-5", "o")) and "chat" not in model_name
                else None,
            )
        else:
            provider = (
                OllamaProvider(openai_client=sdk)
                if name == "ollama"
                else OpenAIProvider(openai_client=sdk)
            )
            profile = (
                {
                    "openai_chat_supports_max_completion_tokens": False,
                    "openai_system_prompt_role": "system",
                    "openai_supports_strict_tool_definition": True,
                    "openai_chat_thinking_field": "reasoning_content",
                }
                if name in {"deepseek", "opencode"}
                else None
            )
            model_cls = _DeepSeekChatModel if name in {"deepseek", "opencode"} else OpenAIChatModel
            model = model_cls(model_name, provider=provider, profile=profile)

    # The provider otherwise treats a supplied client as externally owned.
    # Keep its normal Model/Agent context-manager lifetime, with our safe factory
    # also used when the SDK reopens a closed client.
    provider._own_http_client = client
    provider._http_client_factory = make_client
    if name == "openai-codex":
        provider._http_client_factory = lambda: _codex_client(provider, make_client)
    return model


def _codex_client(provider: Any, factory: Callable[[], httpx2.AsyncClient]) -> httpx2.AsyncClient:
    client = factory()
    provider._http_client = client
    return client


def build_model(
    connection: ModelConnection, *, timeout_s: float = 180.0, max_retries: int = 2
) -> Model:
    """Build a model that uses only an explicit credential and the approved endpoint."""

    base_url = _validated_connection(connection)

    def make_client() -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            transport=_ModelTransport(
                base_url,
                provider=connection.provider,
                no_key=connection.provider in LOCAL_PROVIDERS
                and not (connection.api_key or "").strip(),
                max_retries=max_retries,
                before_request=connection.before_request,
            ),
            follow_redirects=False,
            trust_env=False,
            timeout=max(0.001, timeout_s),
            event_hooks={"response": [_capture_grant_expiry]}
            if connection.provider == "openai-codex"
            else None,
        )

    try:
        return _make_model(connection, base_url, make_client, timeout_s=timeout_s)
    except (ImportError, OSError, TypeError, ValueError, UserError):
        raise ProviderError(
            provider=connection.provider, code="provider_runtime_unavailable"
        ) from None


def _error_code(exc: Exception) -> str:
    if isinstance(exc, ProviderError):
        return exc.code
    cause = exc
    while cause:
        status = (
            cause.status_code
            if isinstance(cause, ModelHTTPError)
            else getattr(cause, "status_code", None)
        )
        if isinstance(status, int):
            if status in (401, 403):
                return "provider_auth_failed"
            if status == 429:
                return "provider_rate_limited"
            if 400 <= status < 500:
                return "provider_model_rejected"
            return "provider_unavailable"
        if isinstance(cause, ProviderError):
            return cause.code
        if isinstance(cause, (CredentialsRefreshError, CredentialsPersistenceError)):
            return "provider_auth_failed"
        cause = cause.__cause__
    if isinstance(exc, (ImportError, UserError)):
        return "provider_runtime_unavailable"
    return "provider_unavailable"


@asynccontextmanager
async def request_errors(provider: str, timeout_s: float) -> AsyncIterator[None]:
    """Cap the entire request lifetime and expose only the stable provider error."""

    try:
        with anyio.fail_after(max(0.001, timeout_s)):
            yield
    except Exception as exc:
        raise ProviderError(provider=provider, code=_error_code(exc)) from None
