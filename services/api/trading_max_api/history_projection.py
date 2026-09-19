"""Lossless transport projections; chart sampling and accounting stay independent."""

from __future__ import annotations

import calendar
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from .dashboard_models import NavPoint

HistoryRange = Literal["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"]
HistoryScope = Literal["invest", "isa", "total", "household", "cfd"]
_ZONE = ZoneInfo("Europe/London")
_SCOPES = ("invest", "isa", "total", "household", "cfd")


def portfolio_day(value: str) -> date:
    if len(value) == 10:
        return date.fromisoformat(value)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (
        parsed.replace(tzinfo=UTC).astimezone(_ZONE).date()
        if parsed.tzinfo is None
        else parsed.astimezone(_ZONE).date()
    )


def window_start(end: date, range_name: HistoryRange) -> date | None:
    while end.weekday() >= 5:
        end -= timedelta(days=1)
    if range_name == "ALL":
        return None
    if range_name == "1D":
        return end
    if range_name == "1W":
        for _ in range(4):
            end -= timedelta(days=1)
            while end.weekday() >= 5:
                end -= timedelta(days=1)
        return end
    if range_name == "YTD":
        return end.replace(month=1, day=1)
    months = {"1M": 1, "3M": 3, "6M": 6, "1Y": 12}[range_name]
    year, month = divmod(end.year * 12 + end.month - 1 - months, 12)
    return date(year, month + 1, min(end.day, calendar.monthrange(year, month + 1)[1]))


def scope_points(points: list[NavPoint], scope: HistoryScope | None) -> list[NavPoint]:
    if scope is None:
        return points
    # The household view derives its explicit CFD proxy from daily totals.
    keep = {scope, "total", "cfd"} if scope == "household" else {scope}
    # The total/household detail table compares the sum of both model values.
    comparison_fields = (
        {"invest_model_value_gbp", "isa_model_value_gbp"}
        if scope in {"total", "household"}
        else set()
    )
    omitted = [
        name
        for name in NavPoint.model_fields
        if name not in comparison_fields
        and any(
            (name == prefix or name.startswith(prefix + "_")) and prefix not in keep
            for prefix in _SCOPES
        )
    ]
    return [point.model_copy(update=dict.fromkeys(omitted)) for point in points]


def project_intraday(
    points: list[NavPoint],
    daily: list[NavPoint],
    *,
    as_of: str,
    range_name: HistoryRange | None,
    scope: HistoryScope | None,
) -> list[NavPoint]:
    if scope == "cfd":
        return []
    selected = points
    if range_name is not None and scope is not None:
        effective_scope = "total" if scope in {None, "household"} else scope
        usable = sorted(
            (point for point in points if getattr(point, effective_scope) is not None),
            key=lambda point: datetime.fromisoformat(point.date.replace("Z", "+00:00")),
        )
        references = [portfolio_day(as_of)] + [
            portfolio_day(point.date)
            for point in daily + usable
            if getattr(point, effective_scope) is not None
        ]
        start = window_start(max(references), range_name)
        if start is not None and usable:
            # The client resolves observed/reconstructed boundaries BEFORE windowing.
            # Preserve the original first usable point, first broker point, and latest
            # point even outside the window. These are context, not extra chart rows.
            anchors = {usable[0].date, usable[-1].date}
            first_broker = next(
                (point for point in usable if point.valuation_source != "reconstructed"), None
            )
            if first_broker:
                anchors.add(first_broker.date)
            selected = [
                point
                for point in points
                if portfolio_day(point.date) >= start or point.date in anchors
            ]
    return scope_points(selected, scope)
