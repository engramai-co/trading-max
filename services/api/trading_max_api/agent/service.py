"""Serve the assistant over the Vercel AI SDK protocol.

Pydantic AI's `VercelAIAdapter` parses requests, runs the agent, streams events
and keeps the conversation in the store. This module binds the user's model,
the run's data snapshot and limits, and keeps upstream error text out of the
stream.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio
from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, PrivateAttr, ValidationError
from pydantic_ai import Agent, CancellationToken, DeferredToolResults
from pydantic_ai.exceptions import RunCancelled, RunTimedOut
from pydantic_ai.messages import ModelMessage, ModelRequest, UserPromptPart
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import BaseChunk, ErrorChunk
from pydantic_ai.usage import RunUsage
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from trading_max.infrastructure import SnapshotIntegrityError
from trading_max.reference.indices import IndexScope

from .deps import AccountScope
from .insights import CalendarDay
from .roles import PageRole, RoleContext
from .runtime import SIDEBAR_FORMAT, USAGE_LIMITS, TurnLimits, error_code, run_context
from .store import SqliteConversationStore
from .tools import Lens, PageRange, Ticker

LOGGER = logging.getLogger("trading_max.assistant")
# The browser runs AI SDK 7, whose UI message stream is the same wire as SDK 6.
SDK_VERSION = 7
RUN_TIMEOUT_SECONDS = 300.0
CONVERSATION_SCOPE = "workspace"
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ChatFormat = Literal["prose", "references"]
type ChartRange = Literal["5D", "3Y", "5Y", "MAX"]
type ResearchWorkspaceLens = Literal["constituents", "tracking", "peers"]
PageHint = Literal[
    "overview", "holdings", "analytics", "sectors", "research", "review", "health", "settings"
]
DEFAULT_TIMEZONE = "Europe/London"
LIST_LIMIT = 100
# Runs are billed by the provider: never two at once in one conversation, and few overall.
MAX_ACTIVE_RUNS = 2


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
    cancellation_token: CancellationToken | None = None


class DepsForRun(Protocol):
    def __call__(self, page_hint: str | None, timezone: str | None) -> Any: ...


class ChatObservation(BaseModel):
    """Identifiers and dates of the observation already visible in the workspace."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "earnings",
        "ex_dividend",
        "dividend_pay",
        "dividend",
        "rating_change",
        "filing",
        "macro",
        "price_key_moments",
        "research_position",
        "research_earnings",
        "research_headline",
        "news_and_events",
        "upcoming_events",
        "decision",
    ]
    evidence_id: str | None = Field(
        default=None, alias="evidenceId", pattern=r"^ev_[a-zA-Z0-9_-]{1,80}$"
    )
    key: str | None = Field(default=None, pattern=r"^[a-f0-9]{20}$")
    field: str | None = Field(
        default=None, pattern=r"^/(?:status|data(?:/[A-Za-z0-9_.~=-]+)+)$", max_length=160
    )
    date: CalendarDay | None = None
    end: CalendarDay | None = None
    instant: AwareDatetime | None = None
    side: Literal["buy", "sell"] | None = None
    ordinal: int | None = Field(default=None, strict=True, ge=0, lt=2000)

    def describe(self) -> str:
        details = [self.kind, self.side, self.evidence_id, self.key, self.field]
        if self.date:
            details.append(
                f"{self.date} to {self.end}" if self.end and self.end != self.date else self.date
            )
        if self.instant:
            details.append(self.instant.isoformat())
        if self.ordinal is not None:
            details.append(f"ordinal {self.ordinal}")
        return ", ".join(filter(None, details))


class ChatContext(BaseModel):
    """What the page shows, sent by the web app beside the Vercel AI SDK fields."""

    model_config = ConfigDict(extra="forbid")

    _reading: tuple[PageRole, RoleContext] | None = PrivateAttr(default=None)
    role: str | None = Field(default=None, max_length=64)
    snapshot_id: str | None = Field(
        default=None, alias="snapshotId", max_length=100, pattern=r"^[A-Za-z0-9_-]+$"
    )
    object: dict[str, Any] | None = Field(default=None, max_length=20)
    page: PageHint | None = None
    scope: AccountScope | None = None
    range: PageRange | ChartRange | None = None
    ticker: Ticker | None = None
    lens: Lens | ResearchWorkspaceLens | None = None
    benchmark: Literal["VOO", "QQQ", "VT", "ALL"] | None = None
    start: CalendarDay | None = None
    end: CalendarDay | None = None
    index_id: str | None = Field(default=None, alias="indexId", pattern=r"^[a-z0-9-]{1,64}$")
    market: IndexScope | None = None
    horizon: Literal["20_sessions", "to_date"] | None = None
    habit: Literal["before_earnings", "basket_buy", "untraded_fall"] | None = None
    timezone: str | None = Field(default=None, max_length=64)
    observation: ChatObservation | None = None


class _SanitizedEventStream(VercelAIEventStream):
    async def on_error(self, error: Exception) -> AsyncIterator[BaseChunk]:
        code = error_code(error)
        LOGGER.warning(
            "assistant run failed",
            extra={"error_code": code, "error_type": type(error).__name__},
        )
        async for chunk in super().on_error(error):
            yield ErrorChunk(error_text=code) if isinstance(chunk, ErrorChunk) else chunk


def _turn_context_metadata(context: ChatContext, snapshot_id: str | None) -> dict[str, Any] | None:
    """Persist the validated page and selected object with the user message."""
    data = context.model_dump(
        mode="json",
        by_alias=True,
        exclude_none=True,
        exclude={"timezone", "snapshot_id"},
    )
    if not data:
        return None
    if context._reading and (selected_scope := getattr(context._reading[1], "scope", None)):
        data["scope"] = selected_scope
    if snapshot_id:
        data["snapshotId"] = snapshot_id
    return data


@dataclass
class _Adapter(VercelAIAdapter):
    turn_context: dict[str, Any] | None = None

    def build_event_stream(self) -> _SanitizedEventStream:
        return _SanitizedEventStream(
            self.run_input,
            accept=self.accept,
            sdk_version=self.sdk_version,
            server_message_id=self.server_message_id,
            manage_system_prompt=self.manage_system_prompt,
        )

    def sanitize_messages(
        self,
        messages: Sequence[ModelMessage],
        *,
        deferred_tool_results: DeferredToolResults | None = None,
    ) -> list[ModelMessage]:
        sanitized = super().sanitize_messages(messages, deferred_tool_results=deferred_tool_results)
        for message in sanitized:
            if isinstance(message, ModelRequest):
                kept = (
                    {k: v for k, v in message.metadata.items() if k == "__pydantic_ai__"}
                    if message.metadata
                    else {}
                )
                if self.turn_context and any(
                    isinstance(part, UserPromptPart) for part in message.parts
                ):
                    kept["turnContext"] = dict(self.turn_context)
                message.metadata = kept or None
        return sanitized


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


def _context(body: dict[str, Any], request: Request) -> ChatContext:
    raw = body.get("context")
    if raw is None:
        # Query parameters remain for clients that cannot add body fields.
        raw = {
            key: value
            for key, value in (
                ("page", request.query_params.get("page")),
                ("timezone", request.query_params.get("tz")),
            )
            if value
        }
    try:
        context = ChatContext.model_validate(raw)
        if context.page not in {"research", "sectors"} and context.range in {
            "5D",
            "3Y",
            "5Y",
            "MAX",
        }:
            raise ValueError("Unsupported chart range")
        if context.page != "research" and context.lens in {"constituents", "tracking", "peers"}:
            raise ValueError("Research-only lens")
        if context.index_id and context.page not in {"research", "sectors"}:
            raise ValueError("Index identity requires an index page")
        if context.market and context.page != "sectors":
            raise ValueError("Market selection requires the Markets page")
        if (context.horizon or context.habit) and context.page != "review":
            raise ValueError("Review-only filters")
        if (context.start or context.end) and (
            context.page != "analytics"
            or not context.start
            or not context.end
            or context.start > context.end
        ):
            raise ValueError("The selected period requires ordered analytics dates")
        if observation := context.observation:
            if not context.snapshot_id or (
                observation.end and (not observation.date or observation.end < observation.date)
            ):
                raise ValueError("An observation requires a publication and ordered dates")
            if observation.kind == "decision":
                if (
                    context.page != "review"
                    or context.scope not in {"invest", "isa"}
                    or not (
                        context.ticker
                        and observation.date
                        and observation.side
                        and observation.ordinal is not None
                    )
                ):
                    raise ValueError(
                        "A selected decision requires its account, ticker, day, side and ordinal"
                    )
            elif (
                context.page != "research"
                or not observation.evidence_id
                or observation.side
                or observation.ordinal is not None
            ):
                raise ValueError("A research observation requires its evidence identifier")
        if context.role:
            from .roles import role_registry

            role = role_registry().get(context.role)
            if not role or role.page != context.page:
                raise ValueError("role does not belong to the supplied page")
            if role.id in {"daily", "weekly"} and (
                context.scope != "broker_total"
                or context.range != ("1W" if role.id == "weekly" else "1D")
                or not context.snapshot_id
                or context.ticker
                or context.lens
            ):
                raise ValueError("brief origin does not match its scope and period")
            selected = role.context_schema.model_validate(context.object or {})
            context._reading = role, selected
            context.object = selected.model_dump(mode="json")
            research_lenses = {
                "your-position": {"overview"},
                "key-moment": {"technical"},
                "earnings-brief": {"analyst", "fundamentals"},
                "company-summary": {"overview"},
            }
            if role.id in research_lenses and (
                context.lens not in research_lenses[role.id]
                or context.ticker != context.object["ticker"]
                or not context.snapshot_id
                or (role.id != "earnings-brief" and context.scope != "broker_total")
            ):
                raise ValueError("Research reading must keep the same listing, lens and snapshot")
            if role.id in {"exposure", "attribution", "market-map", "market-sector", "diagnosis"}:
                job_record = role.id == "diagnosis" and context.object["issue"] == "job"
                if (not context.snapshot_id and not job_record) or context.ticker or context.lens:
                    raise ValueError("A page reading requires its published origin")
                if role.id == "exposure" and context.scope != "broker_total":
                    raise ValueError("Look-through covers the combined broker accounts")
                if role.id != "attribution" and (context.range or context.benchmark):
                    raise ValueError("This page selection has no performance window")
                if role.id in {"market-map", "market-sector", "diagnosis"} and context.scope:
                    raise ValueError("This selection has no account filter")
                if role.id == "attribution" and any(
                    context.object[key] != getattr(context, key)
                    for key in ("scope", "range", "benchmark")
                ):
                    raise ValueError("The selected range must match its page origin")
        elif context.object:
            raise ValueError("object requires a role")
        return context
    except (ValueError, ValidationError):
        raise HTTPException(status_code=422, detail={"code": "assistant_context_invalid"}) from None


async def _closing(
    stream: AsyncIterable[Any], model: Model, release: Callable[[], None]
) -> AsyncIterator[Any]:
    """Close the run's stream and the model's HTTP client however the response ends."""

    try:
        async for chunk in stream:
            yield chunk
    finally:
        try:
            with anyio.CancelScope(shield=True):
                aclose = getattr(stream, "aclose", None)
                if aclose is not None:
                    await aclose()
                await model.__aexit__(None, None, None)
        finally:
            release()


def _log_run(status: str, started: float, model: Model, usage: RunUsage | None = None):
    LOGGER.info(
        "assistant run finished",
        extra={
            "status": status,
            "duration_ms": round((time.monotonic() - started) * 1000),
            "provider": model.system,
            "model": model.model_name,
            "requests": usage.requests if usage else None,
            "tool_calls": usage.tool_calls if usage else None,
            "input_tokens": usage.input_tokens if usage else None,
            "output_tokens": usage.output_tokens if usage else None,
        },
    )


@dataclass
class AssistantService:
    """Run assistant turns and read or delete stored conversations."""

    agent: Agent
    store: SqliteConversationStore
    bind_model: Callable[[], Awaitable[BoundModel]]
    deps_for_run: DepsForRun
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    check_ready: Callable[[], Awaitable[dict[str, Any]]] | None = None
    bind_background_model: Callable[[], Awaitable[BoundModel]] | None = None
    # conversation id -> start time; an entry outlives its run only if a response
    # was abandoned before streaming began, so expire it after the run timeout.
    _active: dict[str, float] = field(default_factory=dict, init=False, repr=False)

    def release(self, conversation_id: str) -> None:
        self._active.pop(conversation_id, None)

    def _expire_abandoned_runs(self) -> None:
        horizon = time.monotonic() - RUN_TIMEOUT_SECONDS - 30
        for stale in [key for key, started in self._active.items() if started < horizon]:
            self.release(stale)

    def claim(self, key: str) -> None:
        """Share the same concurrency limit across chats and role readings."""
        self._expire_abandoned_runs()
        if key in self._active:
            raise HTTPException(status_code=409, detail={"code": "assistant_busy"})
        if len(self._active) >= MAX_ACTIVE_RUNS:
            raise HTTPException(status_code=429, detail={"code": "assistant_busy"})
        self._active[key] = time.monotonic()

    async def status(self) -> dict[str, Any]:
        """Whether a turn could start now, without calling the model."""

        if self.check_ready is None:
            return {"ready": True, "code": None, "provider": None, "model": None}
        return await self.check_ready()

    async def chat(self, request: Request, response_format: ChatFormat = "prose") -> Response:
        try:
            body = await request.json() if await request.body() else None
        except ValueError:
            body = None
        conversation_id = body.get("id") if isinstance(body, dict) else None
        if not isinstance(conversation_id, str) or not CONVERSATION_ID.fullmatch(conversation_id):
            raise HTTPException(status_code=422, detail={"code": "conversation_id_invalid"})
        context = _context(body, request)
        self.claim(conversation_id)
        try:
            return await self._run(request, conversation_id, context, response_format)
        except BaseException:
            self.release(conversation_id)
            raise

    async def _run(
        self,
        request: Request,
        conversation_id: str,
        context: ChatContext,
        response_format: ChatFormat,
    ) -> Response:
        try:
            bound = await self.bind_model()
        except AssistantUnavailable as exc:
            raise HTTPException(status_code=exc.status_code, detail={"code": exc.code}) from None
        zone = _timezone(context.timezone)
        deps = self.deps_for_run(context.page, zone.key)
        if context.snapshot_id:
            # The authenticated workspace owns this store. Require the pinned
            # publication to remain on disk even when it is still the latest.
            try:
                deps = replace(
                    deps,
                    manifest=deps.store.load_manifest(context.snapshot_id, require_retained=True),
                )
            except (FileNotFoundError, SnapshotIntegrityError):
                raise HTTPException(404, detail={"code": "assistant_snapshot_missing"}) from None
        if context._reading:
            role, selected = context._reading
            if role.id == "diagnosis" and not context.snapshot_id:
                deps = replace(deps, manifest=None)
            deps = role.bind(deps, selected)
        model = bound.model
        started = time.monotonic()

        limits = TurnLimits(**asdict(USAGE_LIMITS))

        def completed(result) -> None:
            _log_run("completed", started, model, result.usage - (limits.opening or RunUsage()))

        def cancelled(exc: RunCancelled) -> None:
            _log_run("timed_out" if isinstance(exc, RunTimedOut) else "cancelled", started, model)

        # Entering the model makes it own its HTTP client until the stream ends.
        snapshot_id = getattr(deps, "snapshot_id", None)
        turn_context = _turn_context_metadata(context, snapshot_id)
        await model.__aenter__()
        try:
            response = await _Adapter.dispatch_request(
                request,
                agent=self.agent,
                sdk_version=SDK_VERSION,
                turn_context=turn_context,
                model=model,
                model_settings=bound.settings,
                cancellation_token=bound.cancellation_token,
                deps=deps,
                instructions=run_context(
                    now=self.clock(),
                    timezone=zone,
                    page=context.page,
                    scope=context.scope,
                    period=context.range,
                    ticker=context.ticker,
                    lens=context.lens,
                    benchmark=context.benchmark,
                    window=(context.start, context.end) if context.start and context.end else None,
                    index_id=context.index_id,
                    market=context.market,
                    horizon=context.horizon,
                    habit=context.habit,
                    observation=context.observation.describe() if context.observation else None,
                )
                + (
                    "\nUse the exact account, ticker, decision_date, side and ordinal with "
                    "decision_timing_and_habits for this trade."
                    if context.observation and context.observation.kind == "decision"
                    else ""
                )
                + (SIDEBAR_FORMAT if response_format == "references" else "")
                + (
                    f"\nContinue the {context.role} reading for this object: {context.object}."
                    if context.role
                    else ""
                ),
                usage_limits=limits,
                timeout=RUN_TIMEOUT_SECONDS,
                conversation_store=self.store,
                conversation_scope=CONVERSATION_SCOPE,
                allowed_file_url_schemes=frozenset(),
                allow_uploaded_files=False,
                on_complete=completed,
                on_cancel=cancelled,
            )
        except BaseException:
            with anyio.CancelScope(shield=True):
                await model.__aexit__(None, None, None)
            raise
        if isinstance(response, StreamingResponse):
            if snapshot_id:
                response.headers["X-Assistant-Snapshot-Id"] = snapshot_id
            response.body_iterator = _closing(
                response.body_iterator,
                model,
                lambda: self.release(conversation_id),
            )
        else:
            await model.__aexit__(None, None, None)
            self.release(conversation_id)
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

    async def delete_conversations(self) -> None:
        self._expire_abandoned_runs()
        if any(CONVERSATION_ID.fullmatch(key) for key in self._active):
            raise HTTPException(status_code=409, detail={"code": "assistant_busy"})
        await self.store.delete_scope(CONVERSATION_SCOPE)

    async def delete(self, conversation_id: str) -> None:
        _check_conversation_id(conversation_id)
        self.claim(conversation_id)
        try:
            if await self.store.read_record(conversation_id) is None:
                raise HTTPException(status_code=404, detail={"code": "conversation_not_found"})
            await self.store.delete(conversation_id, scope=CONVERSATION_SCOPE)
        finally:
            self.release(conversation_id)


__all__ = ["AssistantService", "AssistantUnavailable", "BoundModel", "ChatContext", "DepsForRun"]
