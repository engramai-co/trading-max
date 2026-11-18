"""Serve dated events for a specific immutable workspace publication."""

from dataclasses import replace
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import ModelRetry

from ..agent.events import EventArgs, event_data

router = APIRouter(prefix="/v1/snapshots/{run_id}/events", tags=["events"])


class UpcomingQuery(EventArgs):
    model_config = ConfigDict(strict=False)
    timezone: str = Field(default="Europe/London", max_length=128)


class UpcomingItem(BaseModel):
    kind: Literal["macro", "earnings", "ex_dividend", "dividend_pay", "holiday", "half_day"]
    evidence_id: str
    research_event_id: str | None = None
    date: str
    end_date: str | None = None
    instant: str | None = None
    local_date: str
    local_time: str | None
    ticker: str | None = None
    market: str | None = None
    timezone: str | None = None
    publisher: str
    title_en: str
    title_zh: str
    source_url: str | None = None
    time_source_url: str | None = None
    source_as_of: str | None = None
    credit: str | None = None
    licence_url: str | None = None
    fiscal_period: str | None = None
    status: str | None = None
    estimated_eps: float | None = None
    actual_eps: float | None = None
    currency: str | None = None
    unit: str | None = None


class UpcomingPage(BaseModel):
    items: list[UpcomingItem]
    total_items: int
    next_cursor: int | None
    timezone: str
    start: str
    end: str


class EventSource(BaseModel):
    source_id: str
    as_of: str | None


class EventQuality(BaseModel):
    issues: list[str]
    reason_code: str | None = None


class UpcomingReading(BaseModel):
    data: UpcomingPage | None
    status: Literal["ok", "partial", "unavailable"]
    evidence_id: str
    snapshot_id: str
    scope: str
    sources: list[EventSource]
    quality: EventQuality


@router.get("/upcoming", response_model=UpcomingReading, response_model_exclude_unset=True)
def upcoming(
    request: Request,
    run_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,100}$")],
    query: Annotated[UpcomingQuery, Query()],
):
    try:
        zone = ZoneInfo(query.timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(422, "Unknown display timezone") from None
    deps = request.app.state.assistant.deps_for_run(None, zone.key)
    try:
        manifest = request.app.state.store.load_manifest(run_id, require_retained=True)
    except FileNotFoundError:
        raise HTTPException(404, "Snapshot not found") from None
    args = EventArgs.model_validate(query.model_dump(exclude={"timezone"}))
    try:
        return event_data(replace(deps, manifest=manifest), args, upcoming=True)
    except ModelRetry as exc:
        raise HTTPException(422, str(exc)) from None
