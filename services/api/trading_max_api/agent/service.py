"""Serve the assistant over the Vercel AI SDK protocol.

Pydantic AI's `VercelAIAdapter` parses requests, runs the agent, streams events
and keeps the conversation in the store. This module binds the user's model,
the run's data snapshot and limits, and keeps upstream error text out of the
stream.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio
from fastapi import HTTPException
from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import BaseChunk, ErrorChunk
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from .runtime import USAGE_LIMITS, error_code, run_context
from .store import SqliteConversationStore

LOGGER = logging.getLogger("trading_max.assistant")
SDK_VERSION = 6
RUN_TIMEOUT_SECONDS = 300.0
CONVERSATION_SCOPE = "workspace"
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PAGE_HINTS = frozenset(
    {"overview", "holdings", "analytics", "sectors", "research", "review", "health", "settings"}
)
DEFAULT_TIMEZONE = "Europe/London"
LIST_LIMIT = 100


class AssistantUnavailable(RuntimeError):
    """The assistant cannot run: disabled, consent missing or no usable model."""

    def __init__(self, code: str, status_code: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class BoundModel:
    model: Model
    settings: ModelSettings


class DepsForRun(Protocol):
    def __call__(self, page_hint: str | None, timezone: str | None) -> Any: ...


class _SanitizedEventStream(VercelAIEventStream):
    async def on_error(self, error: Exception) -> AsyncIterator[BaseChunk]:
        code = error_code(error)
        LOGGER.warning(
            "assistant run failed",
            extra={"error_code": code, "error_type": type(error).__name__},
        )
        async for chunk in super().on_error(error):
            yield ErrorChunk(error_text=code) if isinstance(chunk, ErrorChunk) else chunk


class _Adapter(VercelAIAdapter):
    def build_event_stream(self) -> _SanitizedEventStream:
        return _SanitizedEventStream(
            self.run_input,
            accept=self.accept,
            sdk_version=self.sdk_version,
            server_message_id=self.server_message_id,
            manage_system_prompt=self.manage_system_prompt,
        )


def _page(value: str | None) -> str | None:
    return value if value in PAGE_HINTS else None


def _timezone(value: str | None) -> ZoneInfo:
    if value and len(value) <= 64:
        try:
            return ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    return ZoneInfo(DEFAULT_TIMEZONE)


def _check_conversation_id(conversation_id: str) -> None:
    if not CONVERSATION_ID.fullmatch(conversation_id):
        raise HTTPException(status_code=404, detail={"code": "conversation_not_found"})


async def _closing(stream: AsyncIterable[Any], model: Model) -> AsyncIterator[Any]:
    """Close the run's stream and the model's HTTP client however the response ends."""

    try:
        async for chunk in stream:
            yield chunk
    finally:
        with anyio.CancelScope(shield=True):
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                await aclose()
            await model.__aexit__(None, None, None)


@dataclass
class AssistantService:
    """Run assistant turns and read or delete stored conversations."""

    agent: Agent
    store: SqliteConversationStore
    bind_model: Callable[[], Awaitable[BoundModel]]
    deps_for_run: DepsForRun
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    async def chat(self, request: Request) -> Response:
        body = await request.json() if await request.body() else None
        conversation_id = body.get("id") if isinstance(body, dict) else None
        if not isinstance(conversation_id, str) or not CONVERSATION_ID.fullmatch(conversation_id):
            raise HTTPException(status_code=422, detail={"code": "conversation_id_invalid"})
        try:
            bound = await self.bind_model()
        except AssistantUnavailable as exc:
            raise HTTPException(status_code=exc.status_code, detail={"code": exc.code}) from None
        page = _page(request.query_params.get("page"))
        zone = _timezone(request.query_params.get("tz"))
        deps = self.deps_for_run(page, zone.key)
        model = bound.model
        # Entering the model makes it own its HTTP client until the stream ends.
        await model.__aenter__()
        try:
            response = await _Adapter.dispatch_request(
                request,
                agent=self.agent,
                sdk_version=SDK_VERSION,
                model=model,
                model_settings=bound.settings,
                deps=deps,
                instructions=run_context(now=self.clock(), timezone=zone, page=page),
                usage_limits=USAGE_LIMITS,
                timeout=RUN_TIMEOUT_SECONDS,
                conversation_store=self.store,
                conversation_scope=CONVERSATION_SCOPE,
                allowed_file_url_schemes=frozenset(),
                allow_uploaded_files=False,
            )
        except BaseException:
            with anyio.CancelScope(shield=True):
                await model.__aexit__(None, None, None)
            raise
        if isinstance(response, StreamingResponse):
            response.body_iterator = _closing(response.body_iterator, model)
        else:
            await model.__aexit__(None, None, None)
        return response

    async def conversations(self) -> list[dict[str, Any]]:
        records = await self.store.list_conversations(scope=CONVERSATION_SCOPE, limit=LIST_LIMIT)
        titles = await self.store.titles([record.conversation_id for record in records])
        return [
            {
                "id": record.conversation_id,
                "title": titles.get(record.conversation_id),
                "updatedAt": record.updated_at.astimezone(UTC).isoformat(),
            }
            for record in records
        ]

    async def messages(self, conversation_id: str) -> list[dict[str, Any]]:
        _check_conversation_id(conversation_id)
        conversation = await self.store.load(conversation_id, scope=CONVERSATION_SCOPE)
        if conversation is None:
            raise HTTPException(status_code=404, detail={"code": "conversation_not_found"})
        messages = _Adapter.dump_messages(conversation.messages, sdk_version=SDK_VERSION)
        return [
            message.model_dump(mode="json", by_alias=True, exclude_none=True)
            for message in messages
        ]

    async def delete(self, conversation_id: str) -> None:
        _check_conversation_id(conversation_id)
        if await self.store.read_record(conversation_id) is None:
            raise HTTPException(status_code=404, detail={"code": "conversation_not_found"})
        await self.store.delete(conversation_id, scope=CONVERSATION_SCOPE)


__all__ = ["AssistantService", "AssistantUnavailable", "BoundModel", "DepsForRun"]
