"""Project reconciled cash flows at observation time, without inferring returns."""

from bisect import bisect_right
from datetime import UTC, datetime
from math import isfinite
from typing import Any

from trading_max.analytics.cash_flow_history import AccountCashFlowHistory


def _time(value: Any) -> datetime:
    stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("cash-flow timestamps require a timezone")
    return stamp.astimezone(UTC)


class CashFlowTimeline:
    def __init__(self, payload: dict | None) -> None:
        self.valid = False
        self.times: list[datetime] = []
        self.totals: list[float] = []
        if not payload or payload.get("verified") is not True:
            return
        try:
            history = AccountCashFlowHistory.model_validate(payload)
            self.start = _time(history.covered_from)
            self.end = _time(history.covered_until)
            rows = sorted((_time(row.occurred_at), row.amount_gbp) for row in history.events)
            total = 0.0
            for stamp, amount in rows:
                if not self.start <= stamp <= self.end or not isfinite(amount):
                    return
                total += amount
                self.times.append(stamp)
                self.totals.append(total)
            self.valid = self.start <= self.end
        except (KeyError, TypeError, ValueError):
            return

    def at(self, observed_at: Any) -> float | None:
        if not self.valid:
            return None
        try:
            stamp = _time(observed_at)
        except (TypeError, ValueError):
            return None
        if not self.start <= stamp <= self.end:
            return None
        index = bisect_right(self.times, stamp) - 1
        return self.totals[index] if index >= 0 else 0.0
