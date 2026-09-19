"""Small deterministic helpers for appending broker valuations to NAV CSVs."""

from __future__ import annotations

import csv
import io
import math
from datetime import UTC, datetime, timedelta


def _utc_time(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("broker observation time must include its time zone")
    return result.astimezone(UTC)


def append_valuation(
    text: str,
    *,
    date: str,
    value: float,
    cash: float = 0.0,
    invested: float = 0.0,
    observed_at: str | None = None,
) -> bytes:
    """Replace the same-day point or append one new point.

    A same-day replacement retains the ledger's reconciled cash flows. New
    dates carry no inferred flow: callers must establish unchanged account
    state or reconstruct the dated ledger before using that path.
    """

    if not math.isfinite(value) or value <= 0:
        raise ValueError("current NAV must be positive and finite")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = list(reader.fieldnames or [])
    original = list(reader)
    if any(str(row.get("Date") or "") > date for row in original):
        raise ValueError("current NAV date precedes retained history")
    same_day = next((row for row in original if row.get("Date") == date), {})
    observed = _utc_time(observed_at) if observed_at is not None else None
    if observed is not None and observed.date().isoformat() != date:
        raise ValueError("broker observation time must match its valuation date")
    rows = [row for row in original if row.get("Date") != date]
    required = [
        "Date",
        "CashGBP",
        "MarketValueGBP",
        "SyntheticNAVGBP",
        "ExternalFlowGBP",
        "WeightedExternalFlowGBP",
        "DailyReturn",
        "TWRWealth",
        "Drawdown",
        "ObservedAt",
    ]
    for field in required:
        if field not in fieldnames:
            fieldnames.append(field)
    previous = rows[-1] if rows else None
    previous_nav = float(previous["SyntheticNAVGBP"]) if previous else None
    external_flow = float(same_day.get("ExternalFlowGBP") or 0.0)
    weighted_flow = float(same_day.get("WeightedExternalFlowGBP") or 0.0)
    if observed is not None and previous is not None and same_day.get("ObservedAt"):
        old_observed = _utc_time(same_day["ObservedAt"])
        if observed < old_observed:
            raise ValueError("current broker observation precedes retained observation")
        interval_start = (
            _utc_time(previous["ObservedAt"])
            if previous.get("ObservedAt")
            else datetime.fromisoformat(previous["Date"]).replace(tzinfo=UTC) + timedelta(days=1)
        )
        old_duration = (old_observed - interval_start).total_seconds()
        new_duration = (observed - interval_start).total_seconds()
        if old_duration > 0 and new_duration > 0:
            weighted_flow = (
                weighted_flow * old_duration
                + external_flow * (observed - old_observed).total_seconds()
            ) / new_duration
    performance_eligible = all(
        row.get("PerformanceStatus", "") in {"", "eligible"} for row in original
    )
    denominator = previous_nav + weighted_flow if previous_nav else None
    daily_return = (
        (value - previous_nav - external_flow) / denominator
        if previous_nav and denominator and denominator > 0 and performance_eligible
        else None
    )
    previous_wealth = float(previous.get("TWRWealth") or 1.0) if previous else 1.0
    wealth = previous_wealth * (1.0 + daily_return) if daily_return is not None else previous_wealth
    peak = max([float(row.get("TWRWealth") or 1.0) for row in rows] + [wealth, 1.0])
    rows.append(
        {
            **same_day,
            "Date": date,
            "CashGBP": f"{cash:.8f}",
            "MarketValueGBP": f"{invested:.8f}",
            "SyntheticNAVGBP": f"{value:.8f}",
            "ExternalFlowGBP": f"{external_flow:.8f}",
            "WeightedExternalFlowGBP": f"{weighted_flow:.8f}",
            "DailyReturn": (f"{daily_return:.12f}" if daily_return is not None else ""),
            "TWRWealth": f"{wealth:.12f}" if daily_return is not None else "",
            "Drawdown": f"{wealth / peak - 1.0:.12f}" if performance_eligible else "",
            "ObservedAt": observed.isoformat() if observed is not None else "",
            **({"ValuationSource": "broker_native"} if "ValuationSource" in fieldnames else {}),
            **(
                {
                    "PerformanceStatus": same_day.get("PerformanceStatus")
                    or previous.get("PerformanceStatus", "")
                }
                if "PerformanceStatus" in fieldnames and previous is not None
                else {}
            ),
        }
    )
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


__all__ = ["append_valuation"]
