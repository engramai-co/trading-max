"""NAV extraction and range selection from the Returns view."""

from collections.abc import Sequence

from ._js import DAY_MS, at_ms, parse_date
from ._js import numeric as numeric
from .types import NavPoint, Range, Scope


def dated_rows[T: NavPoint](data: Sequence[T]) -> list[tuple[int, T]]:
    parsed = [(time, row) for row in data if (time := parse_date(row["date"])) is not None]
    return sorted(parsed, key=lambda entry: entry[0])


def in_range[T: NavPoint](data: Sequence[T], range: Range) -> list[T]:
    sorted_rows = dated_rows(data)
    if range == "ALL" or not sorted_rows:
        return [point for _, point in sorted_rows]
    timestamp, latest = sorted_rows[-1]
    if range == "1D":
        return [point for _, point in sorted_rows if point["date"][:10] == latest["date"][:10]]
    if range == "YTD":
        year = at_ms(timestamp).year
        return [point for time, point in sorted_rows if at_ms(time).year >= year]
    days = {"1W": 7, "1M": 30, "3M": 90, "6M": 183, "2Y": 730}.get(range, 365)
    return [point for time, point in sorted_rows if timestamp - time <= days * DAY_MS]


def nav_number(point: NavPoint | None, scope: Scope, metric: str = "") -> float | None:
    return numeric(point.get(scope + metric)) if point is not None else None


def observed_nav(data: Sequence[NavPoint], scope: Scope, metric: str = "") -> list[NavPoint]:
    rows = [point for point in data if not point.get("intraday")]
    observed = [i for i, point in enumerate(rows) if nav_number(point, scope, metric) is not None]
    return rows[observed[0] : observed[-1] + 1] if observed else []


def period_return(start: object, end: object) -> float | None:
    opening, ending = numeric(start), numeric(end)
    if opening is None or ending is None or opening <= -1:
        return None
    return (1 + ending) / (1 + opening) - 1


def difference(start: object, end: object) -> float | None:
    opening, ending = numeric(start), numeric(end)
    return None if opening is None or ending is None else ending - opening
