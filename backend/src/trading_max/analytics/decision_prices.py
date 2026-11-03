"""Split-adjusted GBP closes for every security a ledger traded, through today.

Decision review compares each buy and sell with what the price did afterwards, so
it needs prices beyond the day a position closed, unlike the daily NAV. Symbols
are resolved exactly like the NAV: each candidate listing must reconcile with the
broker's own GBP trade prices. Returns are measured on the provider's
split-adjusted close, so a later split cannot read as a price collapse.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    HistoryLoader,
    _candidate_symbols_from_ledger,
    _cash_fx_series,
    _default_history,
    _nominal_close,
    _observed_trade_gbp,
)

TRADE_ACTIONS = r"buy|sell"
#: Same acceptance limit as the NAV: a listing whose quotes sit more than 35%
#: away from the broker's fills is the wrong instrument or the wrong unit.
MAX_LOG_DISTANCE = math.log(1.35)
#: Cache rows carry date, close, split, dividend, high and low. Older caches held
#: only the first three and are fetched again once.
CACHE_FORMAT = 2
CACHE_COLUMNS = ["Close", "Stock Splits", "Dividends", "High", "Low"]


def _empty() -> pd.Series:
    return pd.Series(dtype=float)


@dataclass(frozen=True)
class SecurityPrices:
    identity: str
    ticker: str
    name: str
    symbol: str
    closes: pd.Series
    #: GBP per share on each ex-date, on the same split basis as the closes.
    dividends: pd.Series = field(default_factory=_empty)
    #: GBP daily high and low as quoted that day (before later splits), comparable
    #: with the broker's fills; used for the most a same-day round trip could take.
    highs: pd.Series = field(default_factory=_empty)
    lows: pd.Series = field(default_factory=_empty)


class CachedDailyHistory:
    """Daily provider history cached per symbol outside Git.

    Past rows are reused; only the recent tail is fetched again. If the overlap
    with the cached rows disagrees (a split back-adjusts every earlier close),
    the whole window is fetched again instead of mixing two bases.
    """

    def __init__(
        self,
        root: Path,
        *,
        fetch: HistoryLoader = _default_history,
        refresh_after: timedelta = timedelta(hours=6),
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.root = root
        self.fetch = fetch
        self.refresh_after = refresh_after
        self.now = now

    def _path(self, symbol: str) -> Path:
        return self.root / (hashlib.sha256(symbol.encode()).hexdigest()[:24] + ".json")

    @staticmethod
    def _frame(rows: list[list]) -> pd.DataFrame:
        if not rows:
            return pd.DataFrame(columns=CACHE_COLUMNS, dtype=float)
        frame = pd.DataFrame(rows, columns=["Date", *CACHE_COLUMNS])
        frame.index = pd.DatetimeIndex(pd.to_datetime(frame.pop("Date")))
        return frame.astype(float)

    @staticmethod
    def _rows(frame: pd.DataFrame) -> list[list]:
        close = pd.to_numeric(frame.get("Close"), errors="coerce")

        def column(name: str, missing: float) -> pd.Series:
            values = frame.get(name, pd.Series(missing, index=frame.index))
            return pd.to_numeric(values, errors="coerce")

        splits = column("Stock Splits", 0.0).fillna(0.0)
        dividends = column("Dividends", 0.0).fillna(0.0)
        highs = column("High", math.nan)
        lows = column("Low", math.nan)
        index = pd.to_datetime(frame.index)
        if getattr(index, "tz", None) is not None:
            index = index.tz_localize(None)
        rows = []
        for stamp, value, split, dividend, high, low in zip(
            index.normalize(), close, splits, dividends, highs, lows, strict=True
        ):
            if pd.notna(value) and math.isfinite(float(value)):
                rows.append(
                    [
                        stamp.date().isoformat(),
                        float(value),
                        float(split),
                        float(dividend),
                        float(high) if pd.notna(high) else None,
                        float(low) if pd.notna(low) else None,
                    ]
                )
        return rows

    def __call__(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        path = self._path(symbol)
        cached: dict = {}
        with suppress(FileNotFoundError, ValueError):
            cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("format") != CACHE_FORMAT:
            cached = {}
        rows: list[list] = cached.get("rows", [])
        covered_start = date.fromisoformat(cached["start"]) if cached.get("start") else None
        covered_end = date.fromisoformat(cached["end"]) if cached.get("end") else None
        fetched_at = (
            datetime.fromisoformat(cached["fetched_at"]) if cached.get("fetched_at") else None
        )
        fresh = fetched_at is not None and self.now() - fetched_at < self.refresh_after
        covers = (
            covered_start is not None
            and covered_end is not None
            and covered_start <= start
            and (covered_end >= end or fresh)
        )
        if not covers:
            if rows and covered_start is not None and covered_start <= start:
                tail_start = max(start, (covered_end or start) - timedelta(days=7))
                tail = self._rows(self.fetch(symbol, tail_start, end))
                known = {row[0]: row[1] for row in rows}
                overlap = [(known[row[0]], row[1]) for row in tail if row[0] in known]
                consistent = (
                    bool(tail)
                    and all(math.isclose(old, new, rel_tol=0.005) for old, new in overlap)
                    and not any(row[2] for row in tail)
                )
                if consistent:
                    merged = {row[0]: row for row in rows}
                    merged.update({row[0]: row for row in tail})
                    rows = [merged[key] for key in sorted(merged)]
                else:
                    rows = self._rows(self.fetch(symbol, covered_start, end))
            else:
                first = min(start, covered_start) if covered_start else start
                rows = self._rows(self.fetch(symbol, first, end))
                covered_start = first
            payload = {
                "format": CACHE_FORMAT,
                "symbol": symbol,
                "start": (covered_start or start).isoformat(),
                "end": max(end, covered_end or end).isoformat(),
                "fetched_at": self.now().isoformat(),
                "rows": rows,
            }
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            temporary.replace(path)
        frame = self._frame(rows)
        if frame.empty:
            return frame
        window = (frame.index >= pd.Timestamp(start)) & (frame.index <= pd.Timestamp(end))
        return frame[window]


def _converted(series: pd.Series, mode: str, cash_fx: pd.DataFrame, gbpusd: pd.Series) -> pd.Series:
    if mode == "GBP":
        return series
    if mode == "GBX":
        return series / 100.0
    rate = cash_fx.get(mode, gbpusd).reindex(series.index).ffill().bfill()
    return series / rate


def resolve_decision_prices(
    trades: pd.DataFrame,
    *,
    end_day: pd.Timestamp,
    history_loader: HistoryLoader,
    memo: dict[str, str] | None = None,
) -> tuple[dict[str, SecurityPrices], list[str]]:
    """Resolve adjusted GBP closes per identity; return them and unpriced tickers.

    ``trades`` is the output of the NAV's ``_trade_columns`` (it carries
    ``SecurityIdentity``, ``BusinessDate``, ``TradeCurrency`` and settlement totals).
    ``memo`` maps identities to their last accepted listing; it is tried first and
    updated in place, so routine runs request one listing per security.
    """

    fills = trades[
        trades["TradePrice"].notna()
        & trades["Action"].astype(str).str.contains(TRADE_ACTIONS, case=False, regex=True)
        & trades["SecurityIdentity"].notna()
    ]
    if fills.empty:
        return {}, []
    start_day = pd.Timestamp(fills["BusinessDate"].min()) - pd.Timedelta(days=14)
    end_day = pd.Timestamp(end_day).normalize()
    days = pd.bdate_range(start_day, end_day)
    gbpusd = (
        _nominal_close(history_loader("GBPUSD=X", start_day.date(), end_day.date()))
        .reindex(days)
        .ffill()
        .bfill()
    )
    if gbpusd.isna().any():
        raise HistoricalNavError("GBPUSD history is unavailable")
    currencies = {"GBP", "USD"} | {
        value
        for value in pd.concat([trades["TotalCurrency"], trades["TradeCurrency"]])
        .dropna()
        .astype(str)
        if value and value not in {"GBX", "NAN", "<NA>"}
    }
    try:
        cash_fx = _cash_fx_series(
            currencies=currencies,
            days=days,
            start_day=start_day,
            end_day=end_day,
            gbpusd=gbpusd,
            history_loader=history_loader,
        )
    except HistoricalNavError:
        cash_fx = _cash_fx_series(
            currencies={"GBP", "USD"},
            days=days,
            start_day=start_day,
            end_day=end_day,
            gbpusd=gbpusd,
            history_loader=history_loader,
        )
    resolved: dict[str, SecurityPrices] = {}
    unpriced: list[str] = []
    for identity, rows in fills.groupby("SecurityIdentity", sort=True):
        ticker = str(rows["Ticker"].dropna().iloc[-1]).strip().upper()
        name = (
            str(rows["Name"].dropna().iloc[-1]).strip()
            if "Name" in rows and rows["Name"].notna().any()
            else ticker
        )
        currency_values = rows["TradeCurrency"].replace("", pd.NA).dropna()
        currency = str(currency_values.iloc[-1] if not currency_values.empty else "USD").upper()
        observed = _observed_trade_gbp(rows, cash_fx)
        best: tuple[float, str, pd.Series, pd.DataFrame, str] | None = None
        candidates = _candidate_symbols_from_ledger(
            ticker,
            currency,
            isin=identity.removeprefix("isin:") if identity.startswith("isin:") else None,
            rows=rows,
        )
        remembered = (memo or {}).get(identity)
        if remembered in candidates:
            candidates = (remembered, *[symbol for symbol in candidates if symbol != remembered])
        for symbol in candidates:
            if best is not None and best[0] <= MAX_LOG_DISTANCE and best[1] == remembered:
                break
            try:
                frame = history_loader(symbol, start_day.date(), end_day.date())
            except Exception:  # noqa: S112 - an unavailable listing is just a rejected candidate
                continue
            nominal = _nominal_close(frame)
            if nominal.empty:
                continue
            adjusted = pd.to_numeric(frame.get("Close"), errors="coerce").dropna()
            adjusted.index = pd.to_datetime(adjusted.index).tz_localize(None).normalize()
            modes = ["GBP", "GBX", *[c for c in cash_fx.columns if c != "GBP"]]
            for mode in dict.fromkeys(modes):
                candidate = _converted(nominal, mode, cash_fx, gbpusd)
                fills_at = candidate.reindex(rows["BusinessDate"], method="ffill").to_numpy(float)
                left = observed.to_numpy(float)
                valid = np.isfinite(left) & np.isfinite(fills_at) & (left > 0) & (fills_at > 0)
                if not valid.any():
                    continue
                score = float(np.median(np.abs(np.log(left[valid] / fills_at[valid]))))
                if best is None or score < best[0]:
                    best = (
                        score,
                        symbol,
                        _converted(adjusted, mode, cash_fx, gbpusd),
                        frame,
                        mode,
                    )
        if best is None or best[0] > MAX_LOG_DISTANCE:
            unpriced.append(ticker)
            continue
        closes = best[2].reindex(best[2].index.union(days)).sort_index().ffill()
        closes = closes[(closes.index >= start_day) & (closes.index <= end_day)].dropna()
        closes = closes[closes > 0]
        if closes.empty:
            unpriced.append(ticker)
            continue
        extras = {
            column: _gbp_column(best[3], column, best[4], cash_fx, gbpusd)
            for column in ("Dividends", "High", "Low")
        }
        dividends = extras["Dividends"]
        resolved[identity] = SecurityPrices(
            identity,
            ticker,
            name,
            best[1],
            closes,
            dividends=dividends[dividends > 0],
            highs=extras["High"],
            lows=extras["Low"],
        )
        if memo is not None:
            memo[identity] = best[1]
    return resolved, sorted(set(unpriced))


def _gbp_column(
    frame: pd.DataFrame, column: str, mode: str, cash_fx: pd.DataFrame, gbpusd: pd.Series
) -> pd.Series:
    """A provider column in GBP, converted like the closes; empty when absent.

    Dividends stay on the split-adjusted basis of the return closes. Highs and lows
    are restored to the prices quoted that day, the basis of the broker's fills.
    """

    if column not in frame:
        return _empty()
    if column == "Dividends":
        values = pd.to_numeric(frame[column], errors="coerce").dropna()
        values.index = pd.to_datetime(values.index).tz_localize(None).normalize()
    else:
        values = _nominal_close(frame.assign(Close=frame[column]))
    if values.empty:
        return _empty()
    return _converted(values, mode, cash_fx, gbpusd)


__all__ = ["CachedDailyHistory", "SecurityPrices", "resolve_decision_prices"]
