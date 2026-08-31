"""Reconstruct a cash-flow-aware historical NAV from a verified broker ledger.

Trading 212 exposes current account equity and transaction exports, but not a
daily historical equity series.  This module replays the official ledger and
values the resulting positions with Yahoo-compatible daily closes.  The last
row is always replaced by the current, reconciled broker valuation so modeled
history is never presented as a broker-native observation.
"""

from __future__ import annotations

import csv
import io
import json
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from trading_max.analytics.ledger import load_transactions
from trading_max.reference.historical_listings import historical_listing_symbols

EXTERNAL_FLOW_ACTIONS = frozenset({"deposit", "withdrawal", "card debit", "spending cashback"})
CASH_INCOME_ACTIONS = frozenset({"dividend (dividend)", "interest on cash", "lending interest"})
CASH_ADJUSTMENT_ACTIONS = frozenset({"adr fee", "currency conversion", "dividend adjustment"})
CASH_RECONCILIATION_TOLERANCE_GBP = 0.02
CASH_RECONCILIATION_RELATIVE_TOLERANCE = 0.0005

# Trading 212 and Yahoo occasionally use different provider symbols.  This is
# an adapter crosswalk, not a security taxonomy; ordinary LSE symbols are
# discovered through the ``.L`` candidate below.
YAHOO_SYMBOL_ALIASES: Mapping[str, str] = {
    "2AMD": "AMD2.L",
    "2MSF": "MSF2.L",
    "3FB": "FB3.L",
    "3MSF": "MSF3.L",
    "3NVD": "NVD3.L",
    "IHCU": "IUHC.L",
    "IIVI": "COHR",
    "MAG5": "MAG7.L",
    "SPL3": "3SPA.L",
}

# Yahoo symbols encode the listing venue while Trading 212 exports only the
# broker ticker and quote currency.  These are provider-adapter suffixes, not
# security identities: every candidate is still reconciled against the
# broker's own GBP-equivalent trade prices before it can be selected.
YAHOO_VENUE_SUFFIXES_BY_CURRENCY: Mapping[str, tuple[str, ...]] = {
    "AUD": (".AX",),
    "CAD": (".TO", ".V"),
    "CHF": (".SW",),
    "DKK": (".CO",),
    "EUR": (".F", ".DE", ".AS", ".PA", ".MI"),
    "HKD": (".HK",),
    "JPY": (".T",),
    "NOK": (".OL",),
    "SEK": (".ST",),
    "TWD": (".TW", ".TWO"),
}


class HistoricalNavError(ValueError):
    """Raised when a historical NAV cannot be reconstructed without guessing."""


HistoryLoader = Callable[[str, date, date], pd.DataFrame]


@dataclass(frozen=True)
class ReconstructionResult:
    """Serialized historical NAV and its auditable reconstruction metadata."""

    content: bytes
    observations: int
    first_date: str
    last_date: str
    symbols: dict[str, str]
    trade_only_symbols: list[str]
    terminal_value_gap_gbp: float
    terminal_cash_gap_gbp: float
    broker_anchor_cash_adjustment_gbp: float
    performance_eligible: bool


@dataclass(frozen=True)
class SupplementalCashEvent:
    """One cash event present in the API sidecar but absent from the CSV."""

    timestamp: pd.Timestamp
    amount: float
    currency: str
    external_flow: bool


def _default_history(symbol: str, start: date, end: date) -> pd.DataFrame:
    raw = yf.download(
        symbol,
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),
        auto_adjust=False,
        actions=True,
        progress=False,
        threads=False,
    )
    if isinstance(raw.columns, pd.MultiIndex):
        if symbol in raw.columns.get_level_values(0):
            raw = raw[symbol]
        elif symbol in raw.columns.get_level_values(1):
            raw = raw.xs(symbol, axis=1, level=1)
    return raw


def _business_date(value: pd.Timestamp) -> pd.Timestamp:
    day = value.tz_localize(None).normalize()
    return pd.offsets.BDay().rollback(day)


def _identifier(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    text = str(value).strip().upper()
    return "" if text in {"", "NAN", "<NA>"} else text


def _identity(row: Mapping[str, Any]) -> str | None:
    isin = _identifier(row.get("ISIN"))
    ticker = _identifier(row.get("Ticker"))
    if isin:
        return f"isin:{isin}"
    return f"ticker:{ticker}" if ticker else None


def _position_identity(position: Mapping[str, Any]) -> str | None:
    isin = _identifier(position.get("isin"))
    ticker = _identifier(position.get("ticker"))
    if isin:
        return f"isin:{isin}"
    return f"ticker:{ticker}" if ticker else None


def _nominal_close(frame: pd.DataFrame) -> pd.Series:
    close = pd.to_numeric(frame.get("Close"), errors="coerce").dropna()
    if close.empty:
        return close
    splits = pd.to_numeric(
        frame.get("Stock Splits", pd.Series(0.0, index=frame.index)),
        errors="coerce",
    ).fillna(0.0)
    factors = splits.where(splits != 0, 1.0)
    future = factors.shift(-1, fill_value=1.0).iloc[::-1].cumprod().iloc[::-1]
    close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
    future.index = pd.to_datetime(future.index).tz_localize(None).normalize()
    return close * future.reindex(close.index, fill_value=1.0)


def _trade_columns(transactions: pd.DataFrame) -> pd.DataFrame:
    result = transactions.copy()
    result["BusinessDate"] = result["Time"].map(_business_date)
    result["TradePrice"] = pd.to_numeric(result.get("Price / share"), errors="coerce")
    result["TradeFX"] = pd.to_numeric(result.get("Exchange rate"), errors="coerce")
    result["TradeCurrency"] = (
        result.get("Currency (Price / share)", pd.Series("", index=result.index))
        .fillna("")
        .astype(str)
        .str.upper()
    )
    total_currency = result.get("Currency (Total)", pd.Series("GBP", index=result.index))
    fee_currency = result.get(
        "Currency (Currency conversion fee)",
        pd.Series("", index=result.index),
    )
    result["TotalCurrency"] = (
        total_currency.fillna(fee_currency).fillna("GBP").astype(str).str.strip().str.upper()
    )
    result.loc[result["TotalCurrency"].isin({"", "NAN", "<NA>"}), "TotalCurrency"] = "GBP"
    result["SecurityIdentity"] = result.apply(_identity, axis=1)
    return result


def _supplemental_cash_events(
    path: Path | None,
    transactions: pd.DataFrame,
) -> list[SupplementalCashEvent]:
    """Load API cash events genuinely absent from the CSV export.

    The generated CSV omits both legs of wallet currency conversions while the
    cash endpoint exposes them as a same-timestamp DEPOSIT/WITHDRAW pair.  Those
    legs change native wallet balances but are *not* external capital flows.
    Other deposits, withdrawals and account transfers remain external flows.
    Events already present in the CSV are reconciled by immutable reference or,
    for legacy exports, by date/currency/amount before anything is replayed.
    """

    if path is None:
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HistoricalNavError("cash transaction sidecar is invalid") from exc
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise HistoricalNavError("cash transaction sidecar has no items")
    exported_references = {
        _identifier(value)
        for value in transactions.get("ID", pd.Series(dtype=object))
        if _identifier(value)
    }
    api_events: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        event_type = str(item.get("type") or "").strip().upper()
        if event_type not in {
            "DEPOSIT",
            "FEE",
            "INTEREST_ON_FREE_CASH",
            "TRANSFER",
            "WITHDRAW",
        }:
            continue
        try:
            timestamp = pd.Timestamp(str(item["dateTime"]))
            amount = float(item["amount"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HistoricalNavError("wallet cash event has invalid date or amount") from exc
        currency = _identifier(item.get("currency"))
        if not currency:
            raise HistoricalNavError("wallet cash event has no currency")
        api_events.append(
            {
                "type": event_type,
                "timestamp": timestamp,
                "amount": amount,
                "currency": currency,
                "reference": _identifier(item.get("reference")),
            }
        )

    conversion_timestamps: set[pd.Timestamp] = set()
    for timestamp, group in pd.DataFrame(api_events).groupby("timestamp") if api_events else ():
        types = set(group["type"])
        currencies = set(group["currency"])
        if {"DEPOSIT", "WITHDRAW"}.issubset(types) and len(currencies) > 1:
            conversion_timestamps.add(timestamp)

    # API conversion fees have a different reference from the corresponding
    # CSV row, so reference matching alone is insufficient.  Match immutable
    # economics at one-second precision as a second reconciliation key.
    exported_signatures: list[tuple[pd.Timestamp, str, int]] = []
    for row in transactions.itertuples(index=False):
        exported_signatures.append(
            (
                row.Time.floor("s"),
                str(row.TotalCurrency),
                round(float(row.TotalN) * 100),
            )
        )

    unmatched: list[dict[str, Any]] = []
    available_signatures = list(exported_signatures)
    for event in api_events:
        if event["reference"] and event["reference"] in exported_references:
            continue
        signature = (
            event["timestamp"].floor("s"),
            event["currency"],
            round(event["amount"] * 100),
        )
        try:
            available_signatures.remove(signature)
        except ValueError:
            unmatched.append(event)

    # Older reports can carry a different reference for the same transfer.
    # Reconcile remaining standalone external flows by business day, currency
    # and penny amount; conversion groups are intentionally excluded.
    exported_by_day: dict[tuple[pd.Timestamp, str], list[int]] = {}
    for row in transactions.itertuples(index=False):
        if str(row.Action).strip().lower() not in EXTERNAL_FLOW_ACTIONS:
            continue
        key = (row.BusinessDate, str(row.TotalCurrency))
        exported_by_day.setdefault(key, []).append(round(float(row.TotalN) * 100))

    result: list[SupplementalCashEvent] = []
    available_by_day = {key: list(values) for key, values in exported_by_day.items()}
    for event in unmatched:
        is_conversion = event["timestamp"] in conversion_timestamps
        is_external = event["type"] in {"DEPOSIT", "TRANSFER", "WITHDRAW"} and not is_conversion
        if is_external:
            key = (_business_date(event["timestamp"]), event["currency"])
            pennies = round(event["amount"] * 100)
            try:
                available_by_day.setdefault(key, []).remove(pennies)
            except ValueError:
                pass
            else:
                continue
        result.append(
            SupplementalCashEvent(
                timestamp=event["timestamp"],
                amount=event["amount"],
                currency=event["currency"],
                external_flow=is_external,
            )
        )
    return result


def _current_position_map(positions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for position in positions:
        identity = _position_identity(position)
        if identity:
            result[identity] = position
    return result


def _candidate_symbols(
    ticker: str,
    currency: str,
    *,
    isin: str | None = None,
) -> tuple[str, ...]:
    candidates = list(historical_listing_symbols(isin))
    alias = YAHOO_SYMBOL_ALIASES.get(ticker)
    if alias:
        candidates.append(alias)
    if currency in {"GBP", "GBX"}:
        candidates.extend([f"{ticker}.L", ticker])
    else:
        # The quote currency does not identify the listing venue.  London has
        # many USD-denominated ETPs (for example GOO3), whose broker trades are
        # reported in USD while Yahoo publishes the instrument as ``*.L``.
        # Trying only the bare ticker makes a closed position fall back to
        # sparse transaction prices and incorrectly attributes several days
        # of P&L to the next trade date.  Candidate acceptance remains guarded
        # by reconciliation against the broker's observed GBP trade prices.
        candidates.append(ticker)
        candidates.extend(
            f"{ticker}{suffix}" for suffix in YAHOO_VENUE_SUFFIXES_BY_CURRENCY.get(currency, ())
        )
        candidates.append(f"{ticker}.L")
    return tuple(dict.fromkeys(item for item in candidates if item))


def _candidate_symbols_from_ledger(
    ticker: str,
    currency: str,
    *,
    isin: str | None,
    rows: pd.DataFrame,
) -> tuple[str, ...]:
    """Return provider candidates from the live ticker and verified ledger history.

    Broker position endpoints can retain an obsolete display ticker after an
    exchange rename while later transaction exports already use the current
    ticker. Every resulting provider symbol is still accepted only after the
    normal broker-trade price reconciliation.
    """

    ledger_tickers = [ticker]
    ledger_tickers.extend(
        _identifier(value) for value in rows.get("Ticker", pd.Series(dtype=object))
    )
    candidates = [
        symbol
        for ledger_ticker in dict.fromkeys(item for item in ledger_tickers if item)
        for symbol in _candidate_symbols(ledger_ticker, currency, isin=isin)
    ]
    return tuple(dict.fromkeys(candidates))


def _observed_trade_gbp(rows: pd.DataFrame, cash_fx: pd.DataFrame) -> pd.Series:
    """Return broker-observed per-share prices in GBP.

    ``Exchange rate`` is the quote-to-settlement rate, not necessarily a GBP
    rate.  A USD security bought from a USD wallet legitimately reports 1.0;
    treating that as USD/GBP makes a US$345 share look like a £345 share.  The
    settlement total and its explicit currency are therefore the authoritative
    observation, converted with that day's wallet FX series.
    """

    values = pd.Series(np.nan, index=rows.index, dtype=float)
    shares = pd.to_numeric(rows["Shares"], errors="coerce").abs()
    per_share = pd.to_numeric(rows["TotalN"], errors="coerce").abs() / shares
    for index, row in rows.iterrows():
        currency = str(row["TotalCurrency"])
        business_day = row["BusinessDate"]
        if currency not in cash_fx or business_day not in cash_fx.index:
            continue
        factor = float(cash_fx.loc[business_day, currency])
        if factor > 0 and pd.notna(per_share.loc[index]):
            values.loc[index] = float(per_share.loc[index]) / factor
    return values


def _cash_fx_series(
    *,
    currencies: set[str],
    days: pd.DatetimeIndex,
    start_day: pd.Timestamp,
    end_day: pd.Timestamp,
    gbpusd: pd.Series,
    history_loader: HistoryLoader,
) -> pd.DataFrame:
    """Return foreign-currency units per GBP for every wallet currency."""

    result = pd.DataFrame(index=days, dtype=float)
    for currency in sorted(currencies):
        if currency == "GBP":
            result[currency] = 1.0
            continue
        if currency == "USD":
            result[currency] = gbpusd
            continue
        if currency == "GBX":
            raise HistoricalNavError("GBX is not a valid wallet cash currency")
        symbol = f"GBP{currency}=X"
        try:
            frame = history_loader(
                symbol,
                (start_day - pd.Timedelta(days=14)).date(),
                end_day.date(),
            )
        except Exception as exc:
            raise HistoricalNavError(f"{symbol} history is unavailable") from exc
        series = _nominal_close(frame).reindex(days).ffill().bfill()
        if series.isna().any() or (series <= 0).any():
            raise HistoricalNavError(f"{symbol} history is unavailable")
        result[currency] = series
    return result


def _event_weight(timestamp: pd.Timestamp, business_day: pd.Timestamp) -> float:
    event_day = timestamp.tz_localize(None).normalize()
    hour = timestamp.hour + timestamp.minute / 60 + timestamp.second / 3600
    return 1.0 if event_day != business_day else max(0.0, min(1.0, (24 - hour) / 24))


def _resolve_price_series(
    *,
    ticker: str,
    currency: str,
    isin: str | None = None,
    rows: pd.DataFrame,
    start: date,
    end: date,
    gbpusd: pd.Series,
    cash_fx: pd.DataFrame,
    history_loader: HistoryLoader,
    allow_trade_only: bool,
) -> tuple[str, pd.Series]:
    trades = rows[
        rows["TradePrice"].notna()
        & rows["Action"].astype(str).str.contains("buy|sell", case=False, regex=True)
    ].copy()
    observed = _observed_trade_gbp(trades, cash_fx)
    best: tuple[float, str, pd.Series] | None = None
    failures: list[str] = []
    for symbol in _candidate_symbols_from_ledger(
        ticker,
        currency,
        isin=isin,
        rows=rows,
    ):
        try:
            nominal = _nominal_close(history_loader(symbol, start, end))
        except Exception as exc:
            failures.append(f"{symbol}: {type(exc).__name__}")
            continue
        if nominal.empty:
            failures.append(f"{symbol}: empty")
            continue
        quote_modes: dict[str, pd.Series] = {
            "GBP": nominal,
            "GBX": nominal / 100.0,
        }
        for quote_currency in cash_fx.columns:
            if quote_currency == "GBP":
                continue
            rate = cash_fx[quote_currency].reindex(nominal.index).ffill().bfill()
            if rate.notna().all() and (rate > 0).all():
                quote_modes[quote_currency] = nominal / rate
        # ``gbpusd`` remains an explicit input because it is the mandatory FX
        # bootstrap series.  It also covers USD quote currencies when no USD
        # wallet happens to exist in the broker export.
        quote_modes.setdefault(
            "USD",
            nominal / gbpusd.reindex(nominal.index).ffill().bfill(),
        )
        for mode, converted in quote_modes.items():
            if trades.empty or observed.dropna().empty:
                mode_score = 0.0 if mode == currency else 1.0
                candidate = (mode_score, symbol, converted)
            else:
                candidate_prices = converted.reindex(trades["BusinessDate"], method="ffill")
                left = observed.to_numpy(dtype=float)
                right = candidate_prices.to_numpy(dtype=float)
                valid = np.isfinite(left) & np.isfinite(right) & (left > 0) & (right > 0)
                if not valid.any():
                    continue
                score = float(np.median(np.abs(np.log(left[valid] / right[valid]))))
                candidate = (score, symbol, converted)
            if best is None or candidate[0] < best[0]:
                best = candidate
    if best is None:
        observed_by_day = observed.groupby(trades["BusinessDate"]).median().dropna()
        if observed_by_day.empty or not allow_trade_only:
            raise HistoricalNavError(f"{ticker}: no usable market history ({'; '.join(failures)})")
        # Some GDRs and short-lived ETPs have no Yahoo-compatible listing and
        # cannot safely be substituted with the underlying security. Carry the
        # broker's own transaction prices between trades instead. This keeps
        # realized economics without inventing an ADR/NAV conversion.
        return f"broker-trades:{ticker}", observed_by_day
    score, symbol, series = best
    if score > math.log(1.35):
        observed_by_day = observed.groupby(trades["BusinessDate"]).median().dropna()
        if allow_trade_only and not observed_by_day.empty:
            return f"broker-trades:{ticker}", observed_by_day
        raise HistoricalNavError(
            f"{ticker}: market history does not reconcile to broker trade prices"
        )
    observed_by_day = observed.groupby(trades["BusinessDate"]).median().dropna()
    series = series.reindex(series.index.union(observed_by_day.index)).sort_index()
    series.loc[observed_by_day.index] = series.loc[observed_by_day.index].fillna(observed_by_day)
    return symbol, series


def reconstruct_historical_nav(
    *,
    export_path,
    account: Mapping[str, Any],
    history_loader: HistoryLoader = _default_history,
    cash_transactions_path: Path | None = None,
) -> ReconstructionResult:
    """Replay one verified account ledger into a broker-anchored daily NAV.

    The broker sync has already proved that the consolidated ledger explains
    every current position.  This function repeats that terminal quantity
    check and refuses to publish partial history, missing held prices, or an
    implausible reconstructed cash balance.
    """

    transactions = _trade_columns(load_transactions([export_path]))
    if transactions.empty:
        raise HistoricalNavError("broker export contains no transactions")
    positions = list(account.get("positions") or [])
    current_positions = _current_position_map(positions)
    identities = sorted(item for item in transactions["SecurityIdentity"].dropna().unique())
    if not identities:
        raise HistoricalNavError("broker export contains no security identities")

    supplemental_events = _supplemental_cash_events(cash_transactions_path, transactions)
    start_day = min(
        [transactions["BusinessDate"].min()]
        + [_business_date(event.timestamp) for event in supplemental_events]
    )
    fetched_at = pd.Timestamp(str(account["fetched_at"]).replace("Z", "+00:00"))
    end_day = _business_date(fetched_at)
    days = pd.bdate_range(start_day, end_day)
    if len(days) < 2:
        raise HistoricalNavError("broker ledger does not span two valuation dates")

    fx_frame = history_loader(
        "GBPUSD=X",
        (start_day - pd.Timedelta(days=14)).date(),
        end_day.date(),
    )
    gbpusd = _nominal_close(fx_frame).reindex(days).ffill().bfill()
    if gbpusd.isna().any():
        raise HistoricalNavError("GBPUSD history is unavailable")

    wallet_currencies = set(transactions["TotalCurrency"].dropna().astype(str))
    wallet_currencies.update(event.currency for event in supplemental_events)
    valuation_currencies = set(wallet_currencies)
    valuation_currencies.update(
        value
        for value in transactions["TradeCurrency"].dropna().astype(str)
        if value and value != "GBX"
    )
    cash_fx = _cash_fx_series(
        currencies=valuation_currencies,
        days=days,
        start_day=start_day,
        end_day=end_day,
        gbpusd=gbpusd,
        history_loader=history_loader,
    )

    quantity_delta = pd.DataFrame(0.0, index=days, columns=identities)
    for row in transactions.itertuples(index=False):
        identity = row.SecurityIdentity
        shares = row.Shares
        if not identity or pd.isna(shares):
            continue
        action = str(row.Action).lower()
        if "buy" in action or action == "stock split open":
            quantity_delta.loc[row.BusinessDate, identity] += float(shares)
        elif "sell" in action or action == "stock split close":
            quantity_delta.loc[row.BusinessDate, identity] -= float(shares)
    quantities = quantity_delta.cumsum().mask(lambda frame: frame.abs() < 1e-7, 0.0)

    for identity, position in current_positions.items():
        actual = float(position.get("quantity") or 0.0)
        reconstructed = float(quantities.get(identity, pd.Series([0.0])).iloc[-1])
        if not math.isclose(actual, reconstructed, abs_tol=1e-6):
            raise HistoricalNavError(
                f"{identity}: terminal quantity {reconstructed} does not match broker {actual}"
            )

    price_gbp = pd.DataFrame(index=days, columns=identities, dtype=float)
    symbols: dict[str, str] = {}
    trade_only_symbols: list[str] = []
    for identity in identities:
        rows = transactions[transactions["SecurityIdentity"].eq(identity)]
        position = current_positions.get(identity, {})
        held_days = quantities.index[quantities[identity].abs() > 1e-7]
        price_end_day = end_day
        if identity not in current_positions:
            trade_days = rows.loc[
                rows["Action"].astype(str).str.contains("buy|sell", case=False, regex=True),
                "BusinessDate",
            ].dropna()
            observed_end_days = [
                value
                for value in (
                    held_days.max() if not held_days.empty else None,
                    trade_days.max() if not trade_days.empty else None,
                )
                if value is not None
            ]
            if observed_end_days:
                # A later corporate action must not change the price basis of
                # a position that was already closed. Market data after the
                # final held/traded day is unnecessary because quantity is 0.
                price_end_day = max(observed_end_days)
        ticker = str(position.get("ticker") or rows["Ticker"].dropna().iloc[-1]).strip().upper()
        currency_values = rows["TradeCurrency"].replace("", pd.NA).dropna()
        currency = str(
            position.get("price_currency")
            or (currency_values.iloc[-1] if not currency_values.empty else "USD")
        ).upper()
        symbol, series = _resolve_price_series(
            ticker=ticker,
            currency=currency,
            isin=identity.removeprefix("isin:") if identity.startswith("isin:") else None,
            rows=rows,
            start=(start_day - pd.Timedelta(days=14)).date(),
            end=price_end_day.date(),
            gbpusd=gbpusd,
            cash_fx=cash_fx,
            history_loader=history_loader,
            allow_trade_only=identity not in current_positions,
        )
        if (
            identity not in current_positions
            and price_end_day < end_day
            and symbol.startswith("broker-trades:")
        ):
            # Some providers back-adjust historical closes for a later
            # forward split but expose the split factor only when the request
            # reaches that corporate-action date. Retry the full window only
            # after the closed-position window failed, and accept it only if
            # broker-price reconciliation recovers a real market series.
            full_symbol, full_series = _resolve_price_series(
                ticker=ticker,
                currency=currency,
                isin=identity.removeprefix("isin:") if identity.startswith("isin:") else None,
                rows=rows,
                start=(start_day - pd.Timedelta(days=14)).date(),
                end=end_day.date(),
                gbpusd=gbpusd,
                cash_fx=cash_fx,
                history_loader=history_loader,
                allow_trade_only=True,
            )
            if not full_symbol.startswith("broker-trades:"):
                symbol, series = full_symbol, full_series
        if symbol.startswith("broker-trades:"):
            observed_days = pd.DatetimeIndex(series.dropna().index).normalize()
            unpriced_held_days = held_days.difference(observed_days)
            if not unpriced_held_days.empty:
                raise HistoricalNavError(
                    f"{ticker}: no market history; broker trades cover only "
                    f"{len(held_days) - len(unpriced_held_days)}/{len(held_days)} held dates"
                )
        aligned = series.reindex(days).ffill()
        missing = (quantities[identity].abs() > 1e-7) & aligned.isna()
        if missing.any():
            raise HistoricalNavError(f"{ticker}: missing prices on {int(missing.sum())} held dates")
        price_gbp[identity] = aligned
        symbols[identity] = symbol
        if symbol.startswith("broker-trades:"):
            trade_only_symbols.append(ticker)

    cash_delta = pd.DataFrame(0.0, index=days, columns=sorted(wallet_currencies))
    external_flow = pd.Series(0.0, index=days)
    weighted_flow = pd.Series(0.0, index=days)
    for row in transactions.itertuples(index=False):
        action = str(row.Action)
        lower = action.strip().lower()
        amount = float(row.TotalN)
        cash_change = 0.0
        if "buy" in lower:
            cash_change = -amount
        elif "sell" in lower or (
            lower in EXTERNAL_FLOW_ACTIONS
            or lower in CASH_INCOME_ACTIONS
            or lower in CASH_ADJUSTMENT_ACTIONS
        ):
            cash_change = amount
        elif lower not in {"stock split close", "stock split open"} and abs(amount) > 1e-9:
            # Broker exports include cash-only rows such as ADR fees, dividend
            # adjustments and currency-conversion charges.  They change cash
            # but are not external capital flows and therefore remain P&L.
            if pd.notna(row.Shares):
                raise HistoricalNavError(f"unsupported security action: {action}")
            cash_change = amount
        business_day = row.BusinessDate
        currency = str(row.TotalCurrency)
        cash_delta.loc[business_day, currency] += cash_change
        if lower in EXTERNAL_FLOW_ACTIONS:
            amount_gbp = amount / float(cash_fx.loc[business_day, currency])
            external_flow.loc[business_day] += amount_gbp
            weighted_flow.loc[business_day] += amount_gbp * _event_weight(row.Time, business_day)
    for event in supplemental_events:
        business_day = _business_date(event.timestamp)
        if business_day not in cash_delta.index:
            raise HistoricalNavError("wallet cash event falls outside the reconstructed ledger")
        cash_delta.loc[business_day, event.currency] += event.amount
        if event.external_flow:
            amount_gbp = event.amount / float(cash_fx.loc[business_day, event.currency])
            external_flow.loc[business_day] += amount_gbp
            weighted_flow.loc[business_day] += amount_gbp * _event_weight(
                event.timestamp,
                business_day,
            )
    native_cash = cash_delta.cumsum()
    cash = (native_cash / cash_fx).sum(axis=1)
    market_value = (quantities * price_gbp).sum(axis=1)
    modeled_nav = cash + market_value
    broker_cash = float(account.get("cash_gbp") or 0.0)
    broker_invested = float(account.get("investments_value_gbp") or 0.0)
    broker_total = float(account["total_value_gbp"])
    cash_gap = broker_cash - float(cash.iloc[-1])
    value_gap = broker_total - float(modeled_nav.iloc[-1])

    # Never spread an unexplained residual over history: doing so can create
    # negative NAVs and fabricated returns.  Small broker-vs-close FX and
    # rounding differences use the same 0.05% reconciliation policy as the
    # account snapshot; materially missing dated events still fail closed.
    cash_tolerance = max(
        CASH_RECONCILIATION_TOLERANCE_GBP,
        broker_total * CASH_RECONCILIATION_RELATIVE_TOLERANCE,
    )
    performance_eligible = abs(cash_gap) <= cash_tolerance + 1e-9
    cash.iloc[-1] = broker_cash
    market_value.iloc[-1] = broker_invested
    nav = cash + market_value

    returns = pd.Series(np.nan, index=days, dtype=float)
    wealth = pd.Series(np.nan, index=days, dtype=float)
    wealth_level = 1.0
    peak = 1.0
    drawdown = pd.Series(0.0, index=days, dtype=float)
    for index in range(1, len(days)) if performance_eligible else ():
        prior = float(nav.iloc[index - 1])
        denominator = prior + float(weighted_flow.iloc[index])
        if prior <= 0 or denominator <= 0:
            continue
        value = (float(nav.iloc[index]) - prior - float(external_flow.iloc[index])) / denominator
        returns.iloc[index] = value
        wealth_level *= 1.0 + value
        wealth.iloc[index] = wealth_level
        peak = max(peak, wealth_level)
        drawdown.iloc[index] = wealth_level / peak - 1.0

    rows: list[dict[str, str]] = []
    for index, day in enumerate(days):
        source = "broker_native" if index == len(days) - 1 else "synthetic_reconstruction"
        rows.append(
            {
                "Date": day.date().isoformat(),
                "CashGBP": f"{cash.iloc[index]:.8f}",
                "MarketValueGBP": f"{market_value.iloc[index]:.8f}",
                "SyntheticNAVGBP": f"{nav.iloc[index]:.8f}",
                "ExternalFlowGBP": f"{external_flow.iloc[index]:.8f}",
                "WeightedExternalFlowGBP": f"{weighted_flow.iloc[index]:.8f}",
                "DailyReturn": (
                    f"{returns.iloc[index]:.12f}" if pd.notna(returns.iloc[index]) else ""
                ),
                "TWRWealth": (f"{wealth.iloc[index]:.12f}" if pd.notna(wealth.iloc[index]) else ""),
                "Drawdown": (f"{drawdown.iloc[index]:.12f}" if performance_eligible else ""),
                "ValuationSource": source,
                "PerformanceStatus": (
                    "eligible" if performance_eligible else "missing_dated_cash_events"
                ),
            }
        )
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return ReconstructionResult(
        content=output.getvalue().encode(),
        observations=len(rows),
        first_date=rows[0]["Date"],
        last_date=rows[-1]["Date"],
        symbols=symbols,
        trade_only_symbols=sorted(trade_only_symbols),
        terminal_value_gap_gbp=value_gap,
        terminal_cash_gap_gbp=cash_gap,
        broker_anchor_cash_adjustment_gbp=cash_gap,
        performance_eligible=performance_eligible,
    )


__all__ = [
    "HistoricalNavError",
    "ReconstructionResult",
    "reconstruct_historical_nav",
]
