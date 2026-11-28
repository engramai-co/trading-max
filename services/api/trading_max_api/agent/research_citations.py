"""Reopen a saved research observation against its retained publication and chart."""

from dataclasses import replace
from functools import partial
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from pydantic_ai import ModelRetry

from . import insights, research_tools
from .events import EventArgs, ReleaseMarket, event_data
from .research_roles import MomentContext, PriceContext, SecurityContext
from .roles import ReadingLine, RoleTools, role_registry
from .tools import Ticker


class CitationQuery(BaseModel):
    tool: Literal[
        "price_key_moments",
        "research_position",
        "research_earnings",
        "research_headline",
        "company_profile",
        "news_and_events",
        "upcoming_events",
    ]
    snapshotId: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")
    evidenceId: str = Field(pattern=r"^ev_[a-zA-Z0-9_-]{1,80}$")
    series: research_tools.SeriesId | None = None
    index: str | None = Field(default=None, max_length=64)
    date: insights.CalendarDay | None = None
    start: insights.CalendarDay | None = None
    end: insights.CalendarDay | None = None
    observation: str | None = Field(default=None, pattern=r"^[a-f0-9]{20}$")
    unselected: bool = False
    eventId: str | None = Field(default=None, max_length=2048)
    reference: str | None = Field(default=None, max_length=2048)
    event: str | None = Field(default=None, max_length=48)
    scope: Literal["broker_total", "invest", "isa", "household", "cfd"] = "broker_total"
    timezone: str = Field(default="Europe/London", max_length=128)
    market: ReleaseMarket | None = None
    eventTicker: Ticker | None = None
    limit: int = Field(default=10, ge=1, le=20)
    cursor: int = Field(default=0, ge=0, le=10000000)


class ResearchCitation(BaseModel):
    output: dict
    lines: list[ReadingLine] = []


def resolve_citation(request: Request, ticker: Ticker, query: CitationQuery) -> ResearchCitation:
    missing = HTTPException(404, "cited-research-unavailable")
    try:
        manifest = request.app.state.store.load_manifest(query.snapshotId, require_retained=True)
        deps = replace(
            request.app.state.assistant.deps_for_run("research", query.timezone), manifest=manifest
        )
        if query.series and not query.index:
            deps = replace(
                deps,
                price_series=partial(
                    request.app.state.research.retained_price_series, query.series
                ),
            )
        if query.tool == "company_profile":
            reader = RoleTools.pinned(deps, frozenset({"company_profile"}))
            output = reader.read(research_tools.company_profile, {"ticker": ticker})
            lines = []
        elif query.tool in {"news_and_events", "upcoming_events"}:
            args = EventArgs(
                scope=query.scope,
                start=query.start,
                end=query.end,
                ticker=query.eventTicker,
                market=query.market,
                limit=query.limit,
                cursor=query.cursor,
            )
            output = event_data(deps, args, upcoming=query.tool == "upcoming_events")
            if not any(
                r["evidence_id"] == query.eventId
                for r in (output.get("data") or {}).get("items", [])
            ):
                raise missing
            lines = []
        elif query.tool == "price_key_moments" and (query.unselected or not query.series):
            args = insights.MomentsArgs(
                scope=query.scope,
                ticker=ticker,
                start=query.start,
                end=query.end,
                date=None if query.unselected else query.date,
                index_id=query.index,
                published_series_id=query.series,
            )
            output = insights.moments_data(deps, args)
            lines = []
            if query.eventId and not any(
                e["reference"] == query.eventId and e["kind"] == query.event
                for row in (output.get("data") or {}).get("items", [])
                for e in row["events"]
            ):
                raise missing
        elif query.tool == "research_headline" and not query.series:
            reader = RoleTools.pinned(deps, frozenset({"research_headline"}))
            output = reader.read(
                research_tools.research_headline,
                {"ticker": ticker, "date": query.date, "reference": query.reference},
            )
            lines = []
        else:
            if query.tool == "research_position":
                role, context, tool = (
                    "your-position",
                    PriceContext(
                        ticker=ticker, published_series_id=query.series, index_id=query.index
                    ),
                    research_tools.research_position,
                )
            elif query.tool in {"price_key_moments", "research_headline"}:
                role, context, tool = (
                    "key-moment",
                    MomentContext(
                        ticker=ticker,
                        published_series_id=query.series,
                        index_id=query.index,
                        start=query.start,
                        end=query.end,
                        date=query.date,
                    ),
                    insights.price_key_moments,
                )
            else:
                role, context, tool = (
                    "earnings-brief",
                    SecurityContext(ticker=ticker),
                    research_tools.research_earnings,
                )
            selected = role_registry()[role]
            reader = selected.reader(deps, context)
            output = (
                reader.read(research_tools.research_headline, {"reference": query.reference})
                if query.tool == "research_headline"
                else reader.read(tool, {})
            )
            if not output.get("data"):
                raise missing
            lines = selected.facts(reader, context)
            if query.observation:
                lines = [
                    line
                    for line in lines
                    if line.evidence.arguments.get("observation") == query.observation
                    and line.evidence.evidence_id == query.evidenceId
                ]
                if not lines:
                    raise missing
            if query.eventId:
                lines = [
                    line
                    for line in lines
                    if line.evidence.arguments.get("eventId") == query.eventId
                    and (not query.event or line.evidence.arguments.get("event") == query.event)
                ]
                if not lines:
                    raise missing
        if not output.get("data") or output["evidence_id"] != query.evidenceId:
            raise missing
        return ResearchCitation(output=output, lines=lines)
    except (FileNotFoundError, ValidationError, ModelRetry):
        raise missing from None
