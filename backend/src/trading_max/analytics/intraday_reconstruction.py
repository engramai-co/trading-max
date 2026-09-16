"""Timestamped ledger replay with historical, completed market and FX bars."""

from __future__ import annotations

import hashlib
import json
import logging
import math
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from .historical_nav import (
    HistoricalNavError,
    _candidate_symbols_from_ledger,
    _current_position_map,
    _supplemental_cash_events,
    _trade_columns,
    ledger_events,
)
from .ledger import load_transactions

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class IntradayPrices:
    """Native, nominal prices indexed by when each completed bar is available."""

    close: pd.Series
    currency: str
    cadence_seconds: int
    sessions: tuple[tuple[pd.Timestamp, pd.Timestamp], ...] = ()


IntradayPriceLoader = Callable[[str, pd.Timestamp, pd.Timestamp, str], IntradayPrices]


def completed_prices(
    frame: pd.DataFrame,
    currency: str,
    interval: str,
    sessions: tuple[tuple[pd.Timestamp, pd.Timestamp], ...] = (),
    *,
    bar_sessions: tuple[tuple[pd.Timestamp, pd.Timestamp], ...] = (),
) -> IntradayPrices:
    """Move bar-start labels to their end; undo split adjustment exactly once."""
    seconds = 3600 if interval == "1h" else 300
    if frame.empty:
        return IntradayPrices(pd.Series(dtype=float), currency, seconds, sessions)
    frame = frame.copy()
    frame.index = pd.to_datetime(frame.index, utc=True)
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    close = pd.to_numeric(frame["Close"], errors="coerce")
    split = (
        pd.to_numeric(frame.get("Stock Splits", pd.Series(0.0, index=frame.index)), errors="coerce")
        .fillna(0)
        .replace(0, 1)
    )
    close = close * split.shift(-1, fill_value=1).iloc[::-1].cumprod().iloc[::-1]
    ends = frame.index + pd.Timedelta(seconds=seconds)
    # Short final bars finish at the exchange's actual session close, including
    # early-close sessions. When a provider omits its calendar, use the full
    # interval conservatively, never a not-yet-complete closing price.
    for start, end in bar_sessions or sessions:
        inside = (frame.index >= start) & (frame.index < end) & (ends > end)
        ends = ends.where(~inside, end)
    close.index = ends
    close = close[~close.index.duplicated(keep="last")].dropna().sort_index()
    close = close[np.isfinite(close) & (close > 0)]
    return IntradayPrices(close, currency, seconds, sessions)


class CachedIntradayPriceLoader:
    """Incremental public-price cache outside Git, shared by the two accounts."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.memory: dict[tuple, IntradayPrices] = {}

    def __call__(
        self,
        symbol: str,
        start: pd.Timestamp,
        end: pd.Timestamp,
        interval: str,
    ) -> IntradayPrices:
        memo = (symbol, start.isoformat(), end.isoformat(), interval)
        if memo in self.memory:
            return self.memory[memo]
        # Regular-only cache entries cannot establish extended-hours coverage.
        key = hashlib.sha256(f"{symbol}:{interval}:extended-v2".encode()).hexdigest()[:24]
        path = self.root / f"{key}.json"
        cached: dict[str, Any] = {}
        with suppress(FileNotFoundError, ValueError):
            cached = json.loads(path.read_text())
        old = pd.DataFrame(cached.get("bars", []))
        if not old.empty:
            old.index = pd.to_datetime(old.pop("timestamp"), utc=True)
        sessions = {(pd.Timestamp(a), pd.Timestamp(b)) for a, b in cached.get("sessions", [])}
        bar_sessions = {
            (pd.Timestamp(a), pd.Timestamp(b)) for a, b in cached.get("bar_sessions", [])
        }
        currency = str(cached.get("currency") or "")
        covered_start = pd.Timestamp(cached.get("start", end.isoformat()))
        covered_end = pd.Timestamp(cached.get("end", start.isoformat()))
        if old.empty or covered_start > start or covered_end < end.floor("10min"):
            request_start = (
                start
                if old.empty or covered_start > start
                else max(start, covered_end - pd.Timedelta(days=2))
            )
            ticker = yf.Ticker(symbol)
            frame = ticker.history(
                start=request_start.to_pydatetime(),
                end=end.to_pydatetime(),
                interval=interval,
                auto_adjust=False,
                actions=True,
                prepost=True,
                timeout=15,
            )
            if not frame.empty:
                metadata = ticker.get_history_metadata()
                raw_currency = str(metadata.get("currency") or "")
                currency = "GBX" if raw_currency in {"GBp", "GBX"} else raw_currency.upper()
                if symbol.endswith("=X"):
                    currency = symbol.removeprefix("GBP").removesuffix("=X")
                periods = metadata.get("tradingPeriods")
                if isinstance(periods, pd.DataFrame) and {"start", "end"} <= set(periods):
                    sessions.update(
                        (pd.Timestamp(row.start), pd.Timestamp(row.end))
                        for row in periods.itertuples()
                    )
                    for start_column, end_column in (
                        ("pre_start", "pre_end"),
                        ("start", "end"),
                        ("post_start", "post_end"),
                    ):
                        if {start_column, end_column} <= set(periods):
                            bar_sessions.update(
                                (pd.Timestamp(a), pd.Timestamp(b))
                                for a, b in periods[[start_column, end_column]]
                                .dropna()
                                .itertuples(index=False, name=None)
                                if a < b
                            )
                # A newly effective split changes the provider's historical
                # price basis. Refresh the complete retained window before merge.
                if (
                    not old.empty
                    and pd.to_numeric(
                        frame.get("Stock Splits", pd.Series(dtype=float)), errors="coerce"
                    )
                    .fillna(0)
                    .ne(0)
                    .any()
                ):
                    frame = ticker.history(
                        start=start.to_pydatetime(),
                        end=end.to_pydatetime(),
                        interval=interval,
                        auto_adjust=False,
                        actions=True,
                        prepost=True,
                        timeout=15,
                    )
                    old = pd.DataFrame()
                frame.index = pd.to_datetime(frame.index, utc=True)
                old = pd.concat([old, frame[["Close", "Stock Splits"]]])
                old = old[~old.index.duplicated(keep="last")].sort_index().loc[start:end]
                self.root.mkdir(parents=True, exist_ok=True)
                bars = [
                    {
                        "timestamp": stamp.isoformat(),
                        "Close": float(row.Close),
                        "Stock Splits": float(row["Stock Splits"]),
                    }
                    for stamp, row in old.dropna(subset=["Close"]).iterrows()
                ]
                payload = {
                    "symbol": symbol,
                    "currency": currency,
                    "bars": bars,
                    "sessions": [(a.isoformat(), b.isoformat()) for a, b in sorted(sessions)],
                    "bar_sessions": [
                        (a.isoformat(), b.isoformat()) for a, b in sorted(bar_sessions)
                    ],
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                }
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps(payload, allow_nan=False))
                temporary.replace(path)
        result = completed_prices(
            old,
            currency,
            interval,
            tuple(sorted(sessions)),
            bar_sessions=tuple(sorted(bar_sessions)),
        )
        self.memory[memo] = result
        return result


def _marks(prices: IntradayPrices, timeline: pd.DatetimeIndex) -> pd.Series:
    """Use past marks only; missing bars inside an open session remain missing."""
    if prices.close.empty:
        return pd.Series(np.nan, index=timeline)
    close = prices.close.sort_index()
    values = close.reindex(timeline, method="ffill")
    stamps = pd.Series(close.index, index=close.index).reindex(timeline, method="ffill")
    age = (pd.Series(timeline, index=timeline) - stamps).dt.total_seconds()
    valid = age <= prices.cadence_seconds * 2
    if prices.sessions:
        in_session = pd.Series(False, index=timeline)
        for start, end in prices.sessions:
            in_session |= (timeline >= start + pd.Timedelta(seconds=prices.cadence_seconds)) & (
                timeline <= end
            )
        first = min(a for a, _ in prices.sessions).normalize()
        last = max(b for _, b in prices.sessions).normalize() + pd.Timedelta(days=1)
        covered = (timeline >= first) & (timeline <= last)
        valid |= ~in_session & covered & (age <= 4 * 86400)
    return values.where(valid)


def _mark_times(prices: IntradayPrices, timeline: pd.DatetimeIndex) -> pd.Series:
    if prices.close.empty:
        return pd.Series(pd.NaT, index=timeline, dtype="datetime64[ns, UTC]")
    return pd.Series(
        prices.close.index, index=prices.close.index, dtype="datetime64[ns, UTC]"
    ).reindex(timeline, method="ffill")


def reconstruct_intraday_account(
    *,
    export_path: Path,
    account: dict,
    history_loader: IntradayPriceLoader,
    cash_transactions_path: Path | None = None,
    retention_days: int = 120,
    fine_history_start: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Replay the full ledger and value every ten-minute bucket.

    No prices are backfilled from the future. Price gaps suppress that valuation;
    missing account inputs cannot turn into zero-valued positions. Outputs are
    modeled account values, never certified time-weighted returns.
    """
    end = pd.Timestamp(account["fetched_at"]).tz_convert("UTC")
    start = (end - pd.Timedelta(days=retention_days)).normalize()
    recent = max(
        start, fine_history_start or (pd.Timestamp(datetime.now(UTC)) - pd.Timedelta(days=59))
    ).ceil("h")
    transactions = _trade_columns(load_transactions([export_path]))
    transactions = transactions[transactions["Time"] <= end]
    supplemental = _supplemental_cash_events(cash_transactions_path, transactions)
    events = [e for e in ledger_events(transactions, supplemental) if e.timestamp <= end]
    if not events:
        raise HistoricalNavError("no timestamped ledger events")
    start = max(start, events[0].timestamp)
    timeline = pd.date_range(start.ceil("10min"), end, freq="10min")
    if timeline.empty:
        return pd.DataFrame()
    identities = sorted({e.identity for e in events if e.identity and e.quantity})
    currencies = sorted({e.currency for e in events})
    event_times = pd.DatetimeIndex(sorted({e.timestamp for e in events}))
    quantity_delta = pd.DataFrame(0.0, index=event_times, columns=identities)
    cash_delta = pd.DataFrame(0.0, index=event_times, columns=currencies)
    for event in events:
        if event.identity and event.quantity:
            quantity_delta.loc[event.timestamp, event.identity] += event.quantity
        cash_delta.loc[event.timestamp, event.currency] += event.cash
    positions = _current_position_map(list(account.get("positions") or []))
    terminal = quantity_delta.sum()
    for identity in set(identities) | set(positions):
        actual = float(positions.get(identity, {}).get("quantity") or 0)
        if not math.isclose(float(terminal.get(identity, 0)), actual, abs_tol=1e-6):
            raise HistoricalNavError(
                f"{identity}: timestamped ledger does not reconcile to broker quantity"
            )
    quantities = quantity_delta.cumsum().reindex(timeline, method="ffill").fillna(0)
    cash_balances = cash_delta.cumsum().reindex(timeline, method="ffill").fillna(0)
    price_cadence = pd.Series(0, index=timeline)

    def load_marks(symbol: str) -> tuple[pd.Series, str, pd.Series]:
        try:
            hourly_prices = history_loader(symbol, start - pd.Timedelta(days=4), end, "1h")
        except Exception:
            hourly_prices = IntradayPrices(pd.Series(dtype=float), "", 3600)
        values = _marks(hourly_prices, timeline)
        currency = hourly_prices.currency
        precision = pd.Series(3600, index=timeline)
        if recent <= end:
            try:
                minute_prices = history_loader(symbol, recent, end, "5m")
            except Exception:
                minute_prices = IntradayPrices(pd.Series(dtype=float), currency, 300)
            fine_values = _marks(minute_prices, timeline)
            if currency == "GBX":
                values, currency = values / 100, "GBP"
            fine_currency = minute_prices.currency
            if fine_currency == "GBX":
                fine_values, fine_currency = fine_values / 100, "GBP"
            if currency and fine_currency and currency != fine_currency:
                raise HistoricalNavError(f"{symbol}: hourly and minute quote currencies disagree")
            # Valuation cadence is independent of quote resolution. Use the
            # freshest completed mark. An old five-minute quote carried through
            # a quiet extended session must not override a newer hourly quote.
            use_fine = fine_values.notna() & (
                values.isna()
                | (_mark_times(minute_prices, timeline) >= _mark_times(hourly_prices, timeline))
            )
            precision.loc[use_fine] = 300
            values = values.where(~use_fine, fine_values)
            currency = fine_currency or currency
        return values, currency, precision

    fx: dict[str, pd.Series] = {"GBP": pd.Series(1.0, index=timeline)}
    fx_precision: dict[str, pd.Series] = {
        "GBP": pd.Series(0, index=timeline),
        "GBX": pd.Series(0, index=timeline),
    }

    def currency_rate(currency: str) -> pd.Series:
        if currency == "GBX":
            return pd.Series(100.0, index=timeline)
        if currency not in fx:
            fx[currency], _, fx_precision[currency] = load_marks(f"GBP{currency}=X")
        return fx[currency]

    total_cash = pd.Series(0.0, index=timeline)
    valid = pd.Series(True, index=timeline)
    for currency in currencies:
        balance = cash_balances[currency]
        if balance.abs().max() < 1e-8:
            continue
        converted = balance / currency_rate(currency)
        active = balance.abs().ge(1e-8)
        price_cadence.loc[active] = np.maximum(
            price_cadence[active], fx_precision[currency][active]
        )
        valid &= balance.abs().lt(1e-8) | converted.notna()
        total_cash += converted.fillna(0)
    invested = pd.Series(0.0, index=timeline)
    for identity in identities:
        quantity = quantities[identity].mask(quantities[identity].abs() < 1e-7, 0)
        if not quantity.ne(0).any():
            continue
        rows = transactions[transactions["SecurityIdentity"].eq(identity)]
        position = positions.get(identity, {})
        ticker = str(position.get("ticker") or rows["Ticker"].dropna().iloc[-1]).upper()
        quote_currency = str(
            position.get("price_currency") or rows["TradeCurrency"].iloc[-1]
        ).upper()
        prices = pd.Series(np.nan, index=timeline)
        for symbol in _candidate_symbols_from_ledger(
            ticker,
            quote_currency,
            rows=rows,
            isin=identity.removeprefix("isin:") if identity.startswith("isin:") else None,
        ):
            try:
                native, provider_currency, precision = load_marks(symbol)
                if not provider_currency:
                    continue
                candidate = native / currency_rate(provider_currency)
                if not (candidate.notna() & quantity.ne(0)).any():
                    continue
                broker_value = position.get("current_value_gbp")
                broker_quantity = float(position.get("quantity") or 0)
                if broker_value is not None and broker_quantity > 0 and candidate.notna().any():
                    observed_price = float(broker_value) / broker_quantity
                    last_price = float(candidate.dropna().iloc[-1])
                    if observed_price > 0 and abs(math.log(last_price / observed_price)) > math.log(
                        1.35
                    ):
                        continue
                # A provider can reuse a ticker for another security. Where
                # fills overlap the quote window, compare the nominal quote
                # in the ledger's currency, allowing ordinary intrabar moves.
                trades = rows[rows["Time"].between(start, end) & rows["TradePrice"].gt(0)]
                if not trades.empty and provider_currency == quote_currency:
                    comparable = native.reindex(pd.DatetimeIndex(trades["Time"]), method="ffill")
                    ratio = comparable.to_numpy() / trades["TradePrice"].to_numpy()
                    finite = ratio[np.isfinite(ratio) & (ratio > 0)]
                    if len(finite) and np.median(np.abs(np.log(finite))) > math.log(1.35):
                        continue
                prices = candidate
                active = quantity.ne(0)
                price_cadence.loc[active] = np.maximum(
                    price_cadence[active],
                    np.maximum(precision[active], fx_precision[provider_currency][active]),
                )
                break
            except Exception as exc:
                LOGGER.debug(
                    "intraday price candidate unavailable: %s (%s)", symbol, type(exc).__name__
                )
        valid &= quantity.eq(0) | prices.notna()
        invested += (quantity * prices).fillna(0)
    valid &= total_cash.ge(-0.02) & (total_cash + invested).ge(0)
    return pd.DataFrame(
        {
            "value": total_cash + invested,
            "cash": total_cash.clip(lower=0),
            "cadence": 600,
            "price_cadence": price_cadence,
        },
        index=timeline,
    ).loc[valid]


__all__ = [
    "CachedIntradayPriceLoader",
    "IntradayPriceLoader",
    "IntradayPrices",
    "completed_prices",
    "reconstruct_intraday_account",
]
