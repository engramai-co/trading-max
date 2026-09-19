"""Dated FX evidence for GBP analytics; no conversion without an observed rate."""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd

FX_CACHE_VERSION = "historical-fx-v1"
MAX_FX_AGE = timedelta(days=7)


def normalized_currency(value: object) -> str:
    """Keep provider pence spelling distinct from pounds before uppercasing."""
    text = str(value).strip() if value is not None else ""
    return "GBX" if text in {"GBp", "GBX"} else text.upper()


@dataclass(frozen=True)
class FxQuote:
    currency: str
    native_per_gbp: Decimal
    observed_at: datetime
    source: str

    def to_gbp(self, amount: Decimal) -> Decimal:
        if (
            not amount.is_finite()
            or not self.native_per_gbp.is_finite()
            or self.native_per_gbp <= 0
        ):
            raise ValueError("FX amounts and rates must be finite and the rate positive")
        return amount / self.native_per_gbp

    def as_dict(self) -> dict[str, str]:
        return {
            "currency": self.currency,
            "native_per_gbp": str(self.native_per_gbp),
            "observed_at": self.observed_at.isoformat(),
            "source": self.source,
        }


FxResolver = Callable[[str, datetime], FxQuote | None]
FxHistoryLoader = Callable[[str, date, date], pd.DataFrame]


def resolve_fx(
    currency: str,
    occurred_at: datetime,
    *,
    resolver: FxResolver | None = None,
    broker_rate_native_per_gbp: Decimal | None = None,
) -> FxQuote | None:
    """Prefer a proven broker GBP conversion, otherwise use earlier FX evidence.

    The caller must establish that a broker rate relates this currency to GBP;
    a quote-to-wallet rate between two foreign currencies is not such evidence.
    No currency default, future quote, or stale rate is silently accepted.
    """
    currency = normalized_currency(currency)
    if occurred_at.tzinfo is None or not re.fullmatch(r"[A-Z]{3}", currency):
        return None
    occurred_at = occurred_at.astimezone(UTC)
    if currency in {"GBP", "GBX"}:
        return FxQuote(
            currency, Decimal(1 if currency == "GBP" else 100), occurred_at, "currency-unit"
        )
    if broker_rate_native_per_gbp is not None:
        try:
            rate = Decimal(str(broker_rate_native_per_gbp))
        except InvalidOperation:
            return None
        if not rate.is_finite() or rate <= 0:
            return None
        return FxQuote(currency, rate, occurred_at, "broker-exchange-rate")
    if resolver is None:
        return None
    try:
        quote = resolver(currency, occurred_at)
        if (
            not isinstance(quote, FxQuote)
            or normalized_currency(quote.currency) != currency
            or not isinstance(quote.observed_at, datetime)
            or quote.observed_at.tzinfo is None
            or not isinstance(quote.native_per_gbp, Decimal)
            or not quote.native_per_gbp.is_finite()
            or quote.native_per_gbp <= 0
            or not timedelta(0) <= occurred_at - quote.observed_at <= MAX_FX_AGE
        ):
            return None
        return quote
    except (ArithmeticError, OSError, RuntimeError, TypeError, ValueError):
        return None


class HistoricalFxResolver:
    """Cache public daily FX observations using the existing NAV price adapter.

    Daily closes are conservatively available only at the following UTC
    midnight. Event queries use the latest completed close at or before the
    event, for at most seven days (weekends/holidays); never a future backfill.
    The selected quote retains its source and availability timestamp.
    """

    def __init__(self, cache_root: Path, *, history_loader: FxHistoryLoader | None = None) -> None:
        self.cache_root = cache_root
        self.history_loader = history_loader
        self._quotes: dict[tuple[str, int], list[FxQuote]] = {}
        self._loaded_through: dict[tuple[str, int], date] = {}

    def __call__(self, currency: str, occurred_at: datetime) -> FxQuote | None:
        currency = normalized_currency(currency)
        if occurred_at.tzinfo is None or not re.fullmatch(r"[A-Z]{3}", currency):
            return None
        occurred_at = occurred_at.astimezone(UTC)
        key = (currency, occurred_at.year)
        through = min(date(occurred_at.year, 12, 31), datetime.now(UTC).date() - timedelta(days=1))
        if key not in self._quotes or self._loaded_through[key] < through:
            self._quotes[key] = self._load(currency, occurred_at.year)
            self._loaded_through[key] = through
        eligible = [
            quote
            for quote in self._quotes[key]
            if timedelta(0) <= occurred_at - quote.observed_at <= MAX_FX_AGE
        ]
        return max(eligible, key=lambda quote: quote.observed_at) if eligible else None

    def _load(self, currency: str, year: int) -> list[FxQuote]:
        start = date(year, 1, 1) - MAX_FX_AGE
        end = min(date(year, 12, 31), datetime.now(UTC).date() - timedelta(days=1))
        path = self.cache_root / f"{FX_CACHE_VERSION}-{currency}-{year}.json"
        old: list[FxQuote] = []
        covered_until = date.min
        try:
            cached = json.loads(path.read_text())
            if not isinstance(cached, dict):
                raise ValueError("FX cache must contain an object")
            if cached.get("version") == FX_CACHE_VERSION and cached.get("currency") == currency:
                covered_until = date.fromisoformat(cached["covered_until"])
                for row in cached["quotes"]:
                    rate = Decimal(row["native_per_gbp"])
                    stamp = datetime.fromisoformat(row["observed_at"])
                    if rate.is_finite() and rate > 0 and stamp.tzinfo is not None:
                        old.append(FxQuote(currency, rate, stamp, row["source"]))
        except (OSError, ValueError, TypeError, KeyError, InvalidOperation):
            old = []
            covered_until = date.min
        if old and covered_until >= end:
            return old
        if end < start:
            return old
        try:
            loader = self.history_loader
            if loader is None:
                # Keep provider behavior consistent with the daily NAV adapter;
                # import lazily to avoid coupling its ledger parser to FX setup.
                from .historical_nav import _default_history

                loader = _default_history
            symbol = f"GBP{currency}=X"
            request_start = max(start, covered_until - MAX_FX_AGE) if old else start
            frame = loader(symbol, request_start, end)
            fresh = []
            if not frame.empty and "Close" in frame:
                for stamp, value in frame["Close"].items():
                    close_date = pd.Timestamp(stamp).date()
                    if not request_start <= close_date <= end:
                        # Providers may include the still-forming current
                        # daily candle. Never persist it as a completed close
                        # that could become eligible after an offline restart.
                        continue
                    rate = Decimal(str(value))
                    if not rate.is_finite() or rate <= 0:
                        continue
                    available = close_date + timedelta(days=1)
                    fresh.append(
                        FxQuote(
                            currency,
                            rate,
                            datetime.combine(available, datetime.min.time(), tzinfo=UTC),
                            f"yahoo-daily-close:{symbol}",
                        )
                    )
        except Exception:
            # Provider unavailability is a local metric-coverage result. The
            # caller records missing FX and retains the native ledger intact.
            return old
        quotes = {quote.observed_at: quote for quote in [*old, *fresh]}
        result = sorted(quotes.values(), key=lambda quote: quote.observed_at)
        if fresh:
            payload = {
                "version": FX_CACHE_VERSION,
                "currency": currency,
                "covered_until": end.isoformat(),
                "quotes": [quote.as_dict() for quote in result],
            }
            self.cache_root.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(
                dir=self.cache_root, prefix=".fx-", suffix=".tmp"
            )
            try:
                with os.fdopen(descriptor, "w") as handle:
                    json.dump(payload, handle, sort_keys=True)
                    handle.flush()
                    os.fsync(handle.fileno())
                Path(temporary).replace(path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        return result
