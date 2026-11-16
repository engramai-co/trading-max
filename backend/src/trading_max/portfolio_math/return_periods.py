"""Calendar return grid using observed monthly boundaries and complete months."""

from calendar import monthrange
from collections.abc import Sequence
from itertools import pairwise
from typing import cast

from ._js import DAY_MS, parse_date
from .nav import in_range, nav_number, period_return
from .types import NavPoint, ReturnPeriod, ReturnPeriods, Scope


def _compound(key: str, entries: list[ReturnPeriod], expected: int) -> ReturnPeriod:
    complete = [entry for entry in entries if entry["value"] is not None and not entry["partial"]]
    contiguous = all(right["start"] == left["end"] for left, right in pairwise(complete))
    usable = contiguous and bool(complete)
    bounds = complete if usable else entries
    value = None
    if usable:
        product = 1.0
        for entry in complete:
            product *= 1 + cast(float, entry["value"])
        value = product - 1
    return {
        "key": key,
        "start": bounds[0]["start"] if bounds else "",
        "end": bounds[-1]["end"] if bounds else "",
        "value": value,
        "partial": len(complete) != expected,
    }


def return_periods(
    points: Sequence[NavPoint], scope: Scope, as_of: str | None = None
) -> ReturnPeriods:
    rows = [row for row in in_range(points, "ALL") if not row.get("intraday")]
    monthly_rows: dict[str, list[NavPoint]] = {}
    for row in rows:
        monthly_rows.setdefault(row["date"][:7], []).append(row)
    months: list[ReturnPeriod] = []
    previous = None
    for key, records in monthly_rows.items():
        first, last = records[0], records[-1]
        year, month = (int(part) for part in key.split("-"))
        preceding = f"{year}-{month - 1:02d}" if month > 1 else f"{year - 1}-12"
        from_previous = previous if previous and previous["date"].startswith(preceding) else None
        start = from_previous if from_previous is not None else first
        end_of_month = f"{key}-{monthrange(year, month)[1]:02d}"
        through = (as_of if as_of is not None else rows[-1]["date"])[:10]
        series_complete = all(nav_number(record, scope, "Twr") is not None for record in records)
        end_time, last_time = parse_date(end_of_month), parse_date(last["date"])
        if end_time is None or last_time is None:
            raise ValueError("Return period boundaries must be ISO calendar dates")
        last_day_close = end_time - last_time <= 4 * DAY_MS
        months.append(
            {
                "key": key,
                "start": start["date"],
                "end": last["date"],
                "value": period_return(
                    nav_number(start, scope, "Twr"), nav_number(last, scope, "Twr")
                )
                if series_complete and start is not last
                else None,
                "partial": from_previous is None or through < end_of_month or not last_day_close,
            }
        )
        previous = last
    years = list(dict.fromkeys(entry["key"][:4] for entry in months))[::-1]
    return {
        "years": years,
        "months": months,
        "quarters": [
            _compound(
                f"{year}-Q{quarter + 1}",
                [
                    entry
                    for entry in months
                    if entry["key"].startswith(year) and (int(entry["key"][5:]) - 1) // 3 == quarter
                ],
                3,
            )
            for year in years
            for quarter in range(4)
        ],
        "annual": [
            _compound(year, [entry for entry in months if entry["key"].startswith(year)], 12)
            for year in years
        ],
    }
