"""Small deterministic helpers for appending broker valuations to NAV CSVs."""

from __future__ import annotations

import csv
import io


def append_valuation(
    text: str,
    *,
    date: str,
    value: float,
    cash: float = 0.0,
    invested: float = 0.0,
) -> bytes:
    """Replace the same-day point or append one new point.

    External flow is intentionally zero: a broker valuation alone cannot
    prove a deposit or withdrawal. The caller must provide a separately
    reconciled flow before it can enter the performance series.
    """

    if value <= 0:
        raise ValueError("current NAV must be positive")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = list(reader.fieldnames or [])
    rows = [row for row in reader if row.get("Date") != date]
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
    ]
    for field in required:
        if field not in fieldnames:
            fieldnames.append(field)
    previous = rows[-1] if rows else None
    previous_nav = float(previous["SyntheticNAVGBP"]) if previous else None
    daily_return = value / previous_nav - 1.0 if previous_nav else None
    previous_wealth = float(previous.get("TWRWealth") or 1.0) if previous else 1.0
    wealth = previous_wealth * (1.0 + daily_return) if daily_return is not None else previous_wealth
    peak = max([float(row.get("TWRWealth") or 1.0) for row in rows] + [wealth, 1.0])
    rows.append(
        {
            "Date": date,
            "CashGBP": f"{cash:.8f}",
            "MarketValueGBP": f"{invested:.8f}",
            "SyntheticNAVGBP": f"{value:.8f}",
            "ExternalFlowGBP": "0.00000000",
            "WeightedExternalFlowGBP": "0.00000000",
            "DailyReturn": (f"{daily_return:.12f}" if daily_return is not None else ""),
            "TWRWealth": f"{wealth:.12f}" if daily_return is not None else "",
            "Drawdown": f"{wealth / peak - 1.0:.12f}",
        }
    )
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


__all__ = ["append_valuation"]
