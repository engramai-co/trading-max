"""Preserve the identity and timing of provider earnings observations."""

from __future__ import annotations

from contextlib import suppress
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .facts import fingerprint, number


def earnings_events(
    rows: list[dict[str, Any]], *, timezone: str | None, observed_at: str | None = None
) -> list[dict[str, Any]]:
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
        estimate = number(row.get("EPS Estimate"))
        currency = row.get("EPS Currency") or row.get("earningsCurrency") or row.get("currency")
        if not isinstance(currency, str) or len(currency) != 3 or not currency.isalpha():
            currency = None
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
                # Currency and period belong to the specific EPS observation.
                # Company reporting and market quote currencies can both differ.
                "currency": currency,
                "epsCurrencyMissing": currency is None
                and (estimate is not None or actual is not None),
                "fiscalPeriod": row.get("Fiscal Quarter Ending") or row.get("fiscalPeriod"),
                "asOf": row.get("asOf") or observed_at,
                "actualEps": actual if currency else None,
                "estimatedEps": estimate if currency else None,
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
