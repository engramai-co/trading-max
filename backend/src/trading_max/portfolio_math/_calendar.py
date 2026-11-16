"""London calendar and gap coverage for the unthinned portfolio timeline."""

from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from ._js import DATE_ONLY, at_ms, epoch_ms, iso_ms, parse_date
from .types import Coverage, CoverageRange

LONDON = ZoneInfo("Europe/London")
STEP_MS = 600_000


def london_date(value: str) -> date:
    stamp = parse_date(value)
    if stamp is None:
        raise ValueError(f"Invalid ISO history date: {value}")
    return at_ms(stamp).astimezone(LONDON).date()


def london_midnight(day: date) -> int:
    return epoch_ms(datetime.combine(day, time(), LONDON))


def weekday_display(value: str | int, whole_days: bool) -> bool:
    historical = isinstance(value, str) and DATE_ONLY.fullmatch(value) is not None
    if isinstance(value, str):
        parsed = parse_date(value + "T12:00:00Z" if historical else value)
    else:
        parsed = value
    if parsed is None:
        return True
    parts = at_ms(parsed).astimezone(LONDON)
    weekday = parts.weekday()
    if whole_days or historical:
        return weekday < 5
    return parts.hour < 2 if weekday == 5 else parts.hour >= 22 if weekday == 6 else True


def intraday_timeline(
    dates: Sequence[str], calendar_days: int, end: str, whole_days: bool
) -> tuple[list[str], list[int | None]]:
    parsed = sorted(
        ((stamp, i) for i, value in enumerate(dates) if (stamp := parse_date(value)) is not None),
        key=lambda entry: entry[0],
    )
    if not parsed:
        return [], []
    latest = parse_date(end)
    if latest is None:
        return [], []
    first_day = london_date(end) - timedelta(days=max(0, calendar_days - 1))
    start = london_midnight(first_day)
    end_bucket = (latest - start) // STEP_MS
    row_by_bucket = {}
    for timestamp, row in parsed:
        bucket = (timestamp - start) // STEP_MS
        if 0 <= bucket <= end_bucket:
            row_by_bucket[bucket] = row

    categories: list[str] = []
    indexes: list[int | None] = []
    for bucket in range(end_bucket + 1):
        timestamp = start + bucket * STEP_MS
        if weekday_display(timestamp, whole_days):
            categories.append(iso_ms(timestamp))
            indexes.append(row_by_bucket.get(bucket))
    return categories, indexes


def timeline_coverage(
    categories: list[str], indexes: list[int | None], visible_dates: list[str]
) -> Coverage:
    observed = [i for i, row in enumerate(indexes) if row is not None]
    first = observed[0] if observed else None
    last = observed[-1] if observed else None
    gaps: list[CoverageRange] = []
    ranges: list[CoverageRange] = []

    # Include leading gaps but leave trailing unobserved buckets out of the
    # gap spans. Coverage.status still discloses trailing gaps.
    if last is not None:
        start = 0
        while start <= last:
            present = indexes[start] is not None
            end = start
            while end < last and (indexes[end + 1] is not None) == present:
                end += 1
            (ranges if present else gaps).append(
                {
                    "start": categories[start],
                    "end": categories[end],
                    "startIndex": start,
                    "endIndex": end,
                }
            )
            start = end + 1

    status = (
        "empty"
        if not visible_dates
        else "single"
        if len(visible_dates) == 1
        else "partial"
        if None in indexes
        else "complete"
    )
    return {
        "categoryCount": len(categories),
        "firstObservedAt": visible_dates[0] if visible_dates else None,
        "firstObservedIndex": first,
        "gaps": gaps,
        "lastObservedAt": visible_dates[-1] if visible_dates else None,
        "lastObservedIndex": last,
        "observedCount": len(observed),
        "observedRanges": ranges,
        "status": status,
    }
