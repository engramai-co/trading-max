"""Valuation source selection, London windows and cash-flow reconciliation."""

from calendar import monthrange
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Literal

from ._calendar import (
    intraday_timeline,
    london_date,
    london_midnight,
    timeline_coverage,
    weekday_display,
)
from ._js import DATE_ONLY, DAY_MS, iso_ms, js_round, parse_date
from .nav import dated_rows, nav_number
from .types import CalendarTimeline, HistoryWindow, NavPoint, Number, PortfolioHistory, Range, Scope

PORTFOLIO_RANGES: tuple[Range, ...] = ("1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL")
_DISPLAY_INTERVALS: dict[Range, int] = {"1D": 10, "1W": 30, "1M": 60, "3M": 120, "6M": 240}
_MONTHS: dict[Range, int] = {"1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24}
_ONE_DAY = timedelta(days=1)


def portfolio_range(value: str | None, fallback: Range = "3M") -> Range:
    return next((range for range in PORTFOLIO_RANGES if range == value), fallback)


def history_day(value: str) -> str:
    return value if DATE_ONLY.fullmatch(value) else london_date(value).isoformat()


def _last_weekday(day: date) -> date:
    while day.weekday() >= 5:
        day -= _ONE_DAY
    return day


def trading_day(value: str | None) -> str | None:
    return (
        _last_weekday(date.fromisoformat(history_day(value))).isoformat()
        if value and parse_date(value) is not None
        else None
    )


def _months_before(day: date, months: int) -> date:
    year, month_index = divmod(day.year * 12 + day.month - 1 - months, 12)
    month = month_index + 1
    return date(year, month, min(day.day, monthrange(year, month)[1]))


def history_window(range: Range, last_day: str) -> HistoryWindow:
    end = _last_weekday(date.fromisoformat(last_day))
    start = end
    if range == "ALL":
        return {"endDay": end.isoformat()}
    if range == "1W":
        for _ in (1, 2, 3, 4):
            start = _last_weekday(start - _ONE_DAY)
    elif range == "YTD":
        start = end.replace(month=1, day=1)
    elif range != "1D":
        start = _months_before(end, _MONTHS[range])
    return {"startDay": start.isoformat(), "endDay": end.isoformat()}


def history_display_interval(range: Range, end_day: str | None = None) -> int:
    if range != "YTD":
        return _DISPLAY_INTERVALS.get(range, 1440)
    if not end_day:
        return 1440
    end = date.fromisoformat(end_day)
    start = end.replace(month=1, day=1)
    days = (end - start).days + 1
    if days <= 1:
        return 10
    if days <= 7:
        return 30
    for months, interval in [(1, 60), (3, 120), (6, 240)]:
        if start >= _months_before(end, months):
            return interval
    return 1440


def _project_household(point: NavPoint, cfd_value: Number, flow_offset: float | None) -> NavPoint:
    total = point.get("total")
    flows = point.get("totalNetContributionsGbp")
    value = float(total) + float(cfd_value) if total is not None else None
    contributions = (
        float(flows) + flow_offset if flows is not None and flow_offset is not None else None
    )
    return {
        **point,
        "household": value,
        "householdNetContributionsGbp": contributions,
        "householdNetPnlGbp": value - contributions
        if value is not None and contributions is not None
        else None,
    }


def _timeline(
    points: list[NavPoint],
    source: Literal["intraday", "daily"],
    start_day: str | None,
    end_day: str | None,
    references: list[str],
    interval: int,
    scope: Scope,
    pending: bool,
    whole_days: bool,
) -> CalendarTimeline:
    categories: list[str] = []
    row_indexes: list[int | None] = []
    cadence = None
    if source == "intraday" and points and start_day and end_day:
        # max alone keeps the first tie; the reference stably sorts and takes
        # the last, which can differ when a daily string shares the UTC instant.
        same_day = [
            (parse_date(value), value) for value in references if history_day(value) == end_day
        ]
        last_reference = (
            sorted(same_day, key=lambda item: item[0] or 0)[-1][1] if same_day else None
        )
        if pending:
            end = points[-1]["date"]
        elif last_reference and "T" in last_reference:
            end = last_reference
        else:
            end = iso_ms(london_midnight(date.fromisoformat(end_day) + _ONE_DAY) - 1)
        last_ms, first_ms = parse_date(history_day(end)), parse_date(start_day)
        if last_ms is None or first_ms is None:
            raise ValueError("Timeline boundaries must be ISO calendar dates")
        calendar_days = js_round((last_ms - first_ms) / DAY_MS) + 1
        chart_dates = [
            point["date"]
            if point.get("intraday")
            else iso_ms(
                london_midnight(london_date(point["date"] + "T12:00:00Z") + _ONE_DAY) - 600_000
            )
            for point in points
        ]
        categories, row_indexes = intraday_timeline(chart_dates, calendar_days, end, whole_days)
        cadence = interval
    elif source == "daily" and points and end_day:
        row_by_day = {history_day(point["date"]): i for i, point in enumerate(points)}
        day = date.fromisoformat(start_day or history_day(points[0]["date"]))
        stop = date.fromisoformat(end_day)
        while day <= stop:
            if day.weekday() < 5:
                key = day.isoformat()
                categories.append(key)
                row_indexes.append(row_by_day.get(key))
            day += _ONE_DAY
        cadence = 1440

    anchors = [False] * len(row_indexes)
    for i in range(1, len(row_indexes)):
        previous, current = row_indexes[i - 1], row_indexes[i]
        if previous is None or current is None:
            continue
        before, after = points[previous], points[current]
        # Missing provenance and explicit null compare differently in JS.
        if (
            ("valuationSource" in before) != ("valuationSource" in after)
            or before.get("valuationSource") != after.get("valuationSource")
            or nav_number(before, scope, "NetContributionsGbp")
            != nav_number(after, scope, "NetContributionsGbp")
        ):
            anchors[i - 1] = anchors[i] = True
    timeline: CalendarTimeline = {
        "categories": categories,
        "rowIndexes": row_indexes,
        "anchors": anchors,
    }
    if cadence is not None:
        timeline["displayIntervalMinutes"] = cadence
    return timeline


def select_portfolio_history(
    *,
    range: Range,
    scope: Scope,
    daily: Sequence[NavPoint] = (),
    intraday: Sequence[NavPoint] = (),
    as_of: str | None = None,
    require_cash_flows: bool = False,
) -> PortfolioHistory:
    daily_rows = [point for _, point in dated_rows(daily) if not point.get("intraday")]
    cfd_anchor = daily_rows[-1] if daily_rows else None
    cfd_value = cfd_anchor.get("cfd") if cfd_anchor else None
    household_flows = nav_number(cfd_anchor, "household", "NetContributionsGbp")
    investment_flows = nav_number(cfd_anchor, "total", "NetContributionsGbp")
    cfd_flow_offset = (
        household_flows - investment_flows
        if household_flows is not None and investment_flows is not None
        else None
    )

    usable_daily = [point for point in daily_rows if nav_number(point, scope) is not None]
    by_time: dict[int, NavPoint] = {}
    references = [point["date"] for point in usable_daily]
    daily_only = scope == "cfd" or (scope == "household" and cfd_value is None)
    if not daily_only:
        for stamp, point in dated_rows(intraday):
            if not point.get("intraday"):
                continue
            if scope == "household" and cfd_value is not None:
                point = _project_household(point, cfd_value, cfd_flow_offset)
            if nav_number(point, scope) is None:
                continue
            references.append(point["date"])
            if stamp not in by_time or point.get("valuationSource") != "reconstructed":
                by_time[stamp] = point
    primary = list(by_time.values())
    if as_of and parse_date(as_of) is not None:
        references.append(as_of)
    latest = max(map(history_day, references), default=None)
    window = history_window(range, latest) if latest else {}
    start, end = window.get("startDay"), window.get("endDay")
    interval = history_display_interval(range, end)
    intraday_range = interval < 1440
    allow_daily_prefix = not intraday_range or range in {"6M", "YTD"}
    fallback = intraday_range and daily_only
    source: Literal["intraday", "daily"] = (
        "intraday"
        if intraday_range and not fallback and not (allow_daily_prefix and not primary)
        else "daily"
    )
    first_intraday = history_day(primary[0]["date"]) if primary else None
    prefix = [
        point
        for point in usable_daily
        if allow_daily_prefix
        and (first_intraday is None or history_day(point["date"]) < first_intraday)
    ]
    eligible = usable_daily if fallback else [point for _, point in dated_rows([*prefix, *primary])]
    points = []
    for point in eligible:
        day = history_day(point["date"])
        if (not start or day >= start) and (not end or day <= end):
            points.append(point)
    latest_observation = points[-1]["date"] if points else None
    pending = False
    cutoff = None
    if require_cash_flows:
        covered = [
            i
            for i, point in enumerate(points)
            if nav_number(point, scope, "NetContributionsGbp") is not None
        ]
        pending = len(covered) != len(points)
        if pending and covered:
            points = points[: covered[-1] + 1]
            cutoff = points[-1]["date"]
    whole_days = range not in {"1W", "1M"}
    timeline = _timeline(
        points, source, start, end, references, interval, scope, pending, whole_days
    )
    visible_dates = [
        point["date"] for point in points if weekday_display(point["date"], whole_days)
    ]
    return {
        **window,
        "points": points,
        "source": source,
        "fallback": fallback,
        "timeline": timeline,
        "coverage": timeline_coverage(
            timeline["categories"], timeline["rowIndexes"], visible_dates
        ),
        "pendingCashFlows": pending,
        "cashFlowCutoffAt": cutoff,
        "latestObservationAt": latest_observation,
        "reconstructedCount": sum(
            point.get("valuationSource") == "reconstructed" for point in points
        ),
        "carriedCfdValue": cfd_value if source == "intraday" and scope == "household" else None,
    }
