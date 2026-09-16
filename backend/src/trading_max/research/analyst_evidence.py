"""Preserve the identity and timing of provider earnings observations."""

from __future__ import annotations

from contextlib import suppress
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .facts import fingerprint, number


def earnings_events(rows: list[dict[str, Any]], *, timezone: str | None) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        raw = str(row.get("index") or row.get("Earnings Date") or "")
        try:
            instant = datetime.fromisoformat(raw)
        except ValueError:
            continue
        # A date without a time zone, or midnight placeholder, is a date only.
        exact = instant.tzinfo is not None and (instant.hour, instant.minute) != (0, 0)
        local = instant
        if exact and timezone:
            with suppress(ValueError, KeyError):
                local = instant.astimezone(ZoneInfo(timezone))
        actual = number(row.get("Reported EPS"))
        minute = local.hour * 60 + local.minute
        result.append(
            {
                "id": fingerprint([raw, "earnings"]),
                "type": "earnings",
                "date": local.date().isoformat(),
                "instant": instant.isoformat() if exact else None,
                "timezone": timezone,
                "precision": "minute" if exact else "date",
                "session": ("pre" if minute < 570 else "post" if minute >= 960 else "regular")
                if exact and timezone == "America/New_York"
                else "unknown",
                "status": "reported" if actual is not None else "provider-estimate",
                "actualEps": actual,
                "estimatedEps": number(row.get("EPS Estimate")),
                "surprisePct": (number(row.get("Surprise(%)")) / 100)
                if number(row.get("Surprise(%)")) is not None
                else None,
                "source": "yahoo-finance-earnings-calendar",
            }
        )
    return sorted({r["id"]: r for r in result}.values(), key=lambda r: r["date"], reverse=True)


def attach_forecast_periods(result: dict[str, Any], trends: list[dict[str, Any]]) -> None:
    periods = {str(row.get("period")): row for row in trends}
    for key, currency_key in (
        ("earningsEstimate", "earningsCurrency"),
        ("revenueEstimate", "revenueCurrency"),
    ):
        for row in result.get(key) or []:
            identity = periods.get(str(row.get("period") or row.get("index")), {})
            row["endDate"] = identity.get("endDate")
            row["currency"] = row.get("currency") or identity.get(currency_key)
            row["basis"] = "provider-consensus"
            row["asOf"] = result["asOf"]
