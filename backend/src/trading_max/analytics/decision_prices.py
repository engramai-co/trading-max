"""Split-adjusted GBP closes for every security a ledger traded, through today.

Decision review compares each buy and sell with what the price did afterwards, so
it needs prices beyond the day a position closed, unlike the daily NAV. Symbols
are resolved exactly like the NAV: each candidate listing must reconcile with the
broker's own GBP trade prices. Returns are measured on the provider's
split-adjusted close, so a later split cannot read as a price collapse.

Only completed daily bars are kept or counted. The provider already returns
today's bar while the session is open; it becomes a close when the listing's
exchange calendar says the session has ended, early closes included, or, for an
exchange without a calendar, once its UTC day is over.

A close in another currency is worth its own day's final exchange rate in pounds,
never another day's, so that value, and every effect measured on it, cannot
change later. A day without its rate yet (today's, or one the provider has not
published) is a pending close: a decision is judged by it only once it arrives.
Only a day with no rate due, a weekend or a currency-market holiday, takes the
rate before it.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
from pandas.tseries.holiday import EasterMonday, GoodFriday

from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    HistoryLoader,
    _candidate_symbols_from_ledger,
    _cash_fx_series,
    _nominal_close,
    _observed_trade_gbp,
)
from trading_max.research.calendar import calendar_name, completed_daily_bars, market_calendar

TRADE_ACTIONS = r"buy|sell"
#: Same acceptance limit as the NAV: a listing whose quotes sit more than 35%
#: away from the broker's fills is the wrong instrument or the wrong unit.
MAX_LOG_DISTANCE = math.log(1.35)
#: Cache rows carry date, close, split, dividend, high and low, for completed bars
#: only, beside the listing's exchange. Older caches can hold a bar that was still
#: forming when it was fetched, and are fetched again once.
CACHE_FORMAT = 3
CACHE_COLUMNS = ["Close", "Stock Splits", "Dividends", "High", "Low"]


def _empty() -> pd.Series:
    return pd.Series(dtype=float)


@dataclass(frozen=True)
class SecurityPrices:
    identity: str
    ticker: str
    name: str
    symbol: str
    #: One GBP close per business day through the review day. A day the listing
    #: has no quote for (a holiday, or today before the close), or no final value
    #: in pounds for yet, repeats the close before it, so every window can read a
    #: price.
    closes: pd.Series
    #: GBP per share on each ex-date, on the same split basis as the closes; NaN
    #: on a pending day, whose exchange rate is still to come.
    dividends: pd.Series = field(default_factory=_empty)
    #: GBP daily high and low as quoted that day (before later splits), comparable
    #: with the broker's fills; used for the most a same-day round trip could take.
    highs: pd.Series = field(default_factory=_empty)
    lows: pd.Series = field(default_factory=_empty)
    #: The days in ``closes`` the provider quoted; ``None`` when it quoted all of
    #: them. Only these are closes a decision can be judged by.
    quote_days: pd.DatetimeIndex | None = None
    #: The quoted days whose close has no final GBP value yet, because that day's
    #: exchange rate is still to come; ``None`` when there are none. They are
    #: still sessions, so counting closes does not shift when their rate arrives.
    pending_days: pd.DatetimeIndex | None = None

    @property
    def quoted(self) -> pd.DatetimeIndex:
        """The days in closes with a close the provider quoted."""

        return self.closes.index if self.quote_days is None else self.quote_days

    @property
    def final_days(self) -> pd.DatetimeIndex:
        """The quoted days whose close has a final GBP value."""

        if self.pending_days is None:
            return self.quoted
        return self.quoted[~self.quoted.isin(self.pending_days)]

    def closes_after(self, day: pd.Timestamp) -> pd.DatetimeIndex:
        """The days after day with a close the provider quoted; a repeated close never counts."""

        return self.quoted[self.quoted > day]


def _listing_history(symbol: str, start: date, end: date) -> pd.DataFrame:
    """Daily provider history whose attrs name the listing's exchange.

    The exchange comes from the metadata yfinance keeps from this same request;
    its get_history_metadata would fetch five days of hourly bars to answer.
    Without that metadata the cache keeps the exchange it already knows.
    """

    ticker = yf.Ticker(symbol)
    frame = ticker.history(
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),
        auto_adjust=False,
        actions=True,
    )
    metadata = getattr(getattr(ticker, "_price_history", None), "_history_metadata", None)
    frame.attrs["exchange"] = str((metadata or {}).get("exchangeName") or "")
    return frame


def _utc(value: datetime) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def _closed_since(exchange: str, fetched_at: datetime, now: datetime, through: date) -> bool:
    """Whether a session up to through has closed since fetched_at, so its bar is new."""

    after, until = _utc(fetched_at), _utc(now)
    if until <= after:
        return False
    name = calendar_name(exchange)
    if name is None:
        # Without a calendar, a bar completes when its UTC day is over.
        return after.date() < min(until.date(), through + timedelta(days=1))
    closes = market_calendar(name, after.year, until.year).closes
    closed = closes[(closes > after) & (closes <= until)]
    return bool((closed.index <= pd.Timestamp(through)).any())


def _last_closed_session(exchange: str, at: datetime, through: date) -> date | None:
    """The latest session up to through that had closed by at."""

    when = _utc(at)
    name = calendar_name(exchange)
    if name is None:
        # Without a calendar, a weekday's bar completes when its UTC day is over.
        last = min(pd.Timestamp(through), pd.Timestamp(when.date()) - pd.Timedelta(days=1))
        return pd.offsets.BDay().rollback(last).date()
    closes = market_calendar(name, when.year, when.year).closes
    closed = closes[(closes <= when) & (closes.index <= pd.Timestamp(through))]
    return None if closed.empty else closed.index[-1].date()


def _lacks_recent_bar(rows: list[list], exchange: str, fetched_at: datetime, through: date) -> bool:
    """Whether the fetch missed the bar of a session closed shortly before it.

    The provider can publish a final bar some time after the close; a missing
    older bar is a gap in its history rather than one still to come.
    """

    session = _last_closed_session(exchange, fetched_at, through)
    if session is None or session < _utc(fetched_at).date() - timedelta(days=7):
        return False
    return all(row[0] != session.isoformat() for row in rows)


class CachedDailyHistory:
    """Daily provider history cached per symbol outside Git.

    Past rows are reused; only the recent tail is fetched again. If the overlap
    with the cached rows disagrees (a split back-adjusts every earlier close),
    the whole window is fetched again instead of mixing two bases.

    A bar whose session has not closed is never cached, and a session that has
    closed since the last fetch has its bar fetched, however recent that was.
    A closed session whose bar the provider had not yet published is asked for
    again once the refresh interval has passed.
    """

    def __init__(
        self,
        root: Path,
        *,
        fetch: HistoryLoader = _listing_history,
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

    def _completed_rows(
        self, symbol: str, start: date, end: date, exchange: str, now: datetime
    ) -> tuple[list[list], str]:
        """Fetched rows whose session had closed by now, and the listing's exchange."""

        frame = self.fetch(symbol, start, end)
        exchange = str(frame.attrs.get("exchange") or exchange)
        frame.attrs["exchange"] = exchange
        return self._rows(completed_daily_bars(frame, now=_utc(now))), exchange

    def __call__(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        path = self._path(symbol)
        cached: dict = {}
        with suppress(FileNotFoundError, ValueError):
            cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("format") != CACHE_FORMAT:
            cached = {}
        rows: list[list] = cached.get("rows", [])
        exchange = str(cached.get("exchange") or "")
        covered_start = date.fromisoformat(cached["start"]) if cached.get("start") else None
        covered_end = date.fromisoformat(cached["end"]) if cached.get("end") else None
        fetched_at = (
            datetime.fromisoformat(cached["fetched_at"]) if cached.get("fetched_at") else None
        )
        now = self.now()
        fresh = fetched_at is not None and now - fetched_at < self.refresh_after
        covers = (
            covered_start is not None
            and covered_end is not None
            and fetched_at is not None
            and covered_start <= start
            and (covered_end >= end or fresh)
            and not _closed_since(exchange, fetched_at, now, end)
            and (fresh or not _lacks_recent_bar(rows, exchange, fetched_at, end))
        )
        if not covers:
            if rows and covered_start is not None and covered_start <= start:
                tail_start = max(start, (covered_end or start) - timedelta(days=7))
                tail, exchange = self._completed_rows(symbol, tail_start, end, exchange, now)
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
                    rows, exchange = self._completed_rows(symbol, covered_start, end, exchange, now)
            else:
                first = min(start, covered_start) if covered_start else start
                rows, exchange = self._completed_rows(symbol, first, end, exchange, now)
                covered_start = first
            payload = {
                "format": CACHE_FORMAT,
                "symbol": symbol,
                "exchange": exchange,
                "start": (covered_start or start).isoformat(),
                "end": max(end, covered_end or end).isoformat(),
                "fetched_at": now.isoformat(),
                "rows": rows,
            }
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            temporary.replace(path)
        frame = self._frame(rows)
        frame.attrs["exchange"] = exchange
        if frame.empty:
            return frame
        window = (frame.index >= pd.Timestamp(start)) & (frame.index <= pd.Timestamp(end))
        return frame[window]


def _converted(series: pd.Series, mode: str, cash_fx: pd.DataFrame, gbpusd: pd.Series) -> pd.Series:
    """Values in GBP at the latest rate by each day: close enough to match fills with."""

    if mode == "GBP":
        return series
    if mode == "GBX":
        return series / 100.0
    rate = cash_fx.get(mode, gbpusd).reindex(series.index).ffill().bfill()
    return series / rate


def _rate_due(days: pd.DatetimeIndex) -> np.ndarray:
    """Whether each day should have a daily exchange rate of its own.

    None is due at weekends, on Christmas Day and New Year's Day, when the
    currency market closes, or on Good Friday and Easter Monday, which the
    provider can skip.
    """

    first, last = days.min(), days.max()
    easter = GoodFriday.dates(first, last).union(EasterMonday.dates(first, last))
    holiday = ((days.month == 12) & (days.day == 25)) | ((days.month == 1) & (days.day == 1))
    return np.asarray((days.weekday < 5) & ~holiday & ~days.isin(easter))


def final_rate_on(rates: pd.Series, days: pd.DatetimeIndex) -> pd.Series:
    """Each day's final exchange rate, NaN while it is still to come.

    A day takes its own rate. A day with no rate due takes the one before it, but
    only once a later rate is final, by when the provider would have published
    its own. A due rate that is missing is never borrowed from another day, so a
    close in that currency waits for it, however long that takes.
    """

    rates = rates[rates > 0].sort_index()
    rates = rates[~rates.index.duplicated(keep="last")]
    if rates.empty or days.empty:
        return pd.Series(np.nan, index=days, dtype=float)
    span = pd.date_range(min(rates.index.min(), days.min()), days.max(), freq="D")
    own = rates.reindex(span)
    # A missing due rate stops the rate before it from reaching any later day.
    carried = own.mask(_rate_due(span) & own.isna().to_numpy(), -1.0).ffill()
    carried = carried.where((carried > 0) & (span < rates.index.max()))
    return own.fillna(carried).reindex(days)


def _at_final_rates(values: pd.Series, mode: str, final_fx: Mapping[str, pd.Series]) -> pd.Series:
    """Values in GBP at their own day's final rate; NaN on a day still waiting for it."""

    if mode == "GBP":
        return values
    if mode == "GBX":
        return values / 100.0
    rate = final_fx.get(mode)
    if rate is None:
        return values * np.nan
    return values / rate.reindex(values.index).to_numpy()


def final_rates(
    history_loader: HistoryLoader,
    symbol: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
    now: pd.Timestamp,
) -> pd.Series:
    """A currency's GBP rates on the days whose daily rate is final by now.

    A close in that currency has a final GBP value only once its day's rate does:
    until then, converting it at an earlier rate would change after midnight.
    """

    return _nominal_close(
        completed_daily_bars(history_loader(symbol, start.date(), end.date()), now=now)
    )


def resolve_decision_prices(
    trades: pd.DataFrame,
    *,
    end_day: pd.Timestamp,
    history_loader: HistoryLoader,
    memo: dict[str, str] | None = None,
    now: pd.Timestamp | None = None,
) -> tuple[dict[str, SecurityPrices], list[str]]:
    """Resolve adjusted GBP closes per identity; return them and unpriced tickers.

    ``trades`` is the output of the NAV's ``_trade_columns`` (it carries
    ``SecurityIdentity``, ``BusinessDate``, ``TradeCurrency`` and settlement totals).
    ``memo`` maps identities to their last accepted listing; it is tried first and
    updated in place, so routine runs request one listing per security.
    A listing's bars count only once their session has closed by ``now``, read
    from the exchange the loader names in the frame's attrs. A close in a currency
    other than sterling is valued at that day's own final exchange rate; until it
    has one, it is one of the listing's pending days.
    """

    now = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now)
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
    usd_rates = final_rates(history_loader, "GBPUSD=X", start_day, end_day, now)
    gbpusd = usd_rates.reindex(days).ffill().bfill()
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
    # Each currency's final rate on every day, NaN while one is still to come.
    calendar_days = pd.date_range(start_day, end_day, freq="D")
    final_fx = {"USD": final_rate_on(usd_rates, calendar_days)}
    for code in cash_fx.columns:
        if code in {"GBP", "USD"}:
            continue
        with suppress(Exception):
            rates = final_rates(history_loader, f"GBP{code}=X", start_day, end_day, now)
            final_fx[code] = final_rate_on(rates, calendar_days)
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
                frame = completed_daily_bars(
                    history_loader(symbol, start_day.date(), end_day.date()), now=now
                )
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
                    best = (score, symbol, adjusted, frame, mode)
        if best is None or best[0] > MAX_LOG_DISTANCE:
            unpriced.append(ticker)
            continue
        frame, mode = best[3], best[4]
        converted = _at_final_rates(best[2], mode, final_fx)
        extras = {
            column: _gbp_column(frame, column, mode, final_fx)
            for column in ("Dividends", "High", "Low")
        }
        # A pending close repeats the final close before it, like a day without a quote.
        closes = converted.dropna().reindex(converted.index.union(days)).sort_index().ffill()
        closes = closes[(closes.index >= start_day) & (closes.index <= end_day)].dropna()
        closes = closes[closes > 0]
        if closes.empty:
            unpriced.append(ticker)
            continue
        pending = closes.index[closes.index.isin(converted.index[converted.isna()])]
        resolved[identity] = SecurityPrices(
            identity,
            ticker,
            name,
            best[1],
            closes,
            dividends=extras["Dividends"],
            highs=extras["High"],
            lows=extras["Low"],
            quote_days=closes.index[closes.index.isin(converted.index)],
            pending_days=pending if len(pending) else None,
        )
        if memo is not None:
            memo[identity] = best[1]
    return resolved, sorted(set(unpriced))


def _gbp_column(
    frame: pd.DataFrame, column: str, mode: str, final_fx: Mapping[str, pd.Series]
) -> pd.Series:
    """A provider column in GBP at each day's final rate, like the closes; empty when absent.

    Dividends stay on the split-adjusted basis of the return closes; one on a
    pending day has no GBP value yet (NaN). Highs and lows are restored to the
    prices quoted that day, the basis of the broker's fills, and are left out on
    a pending day.
    """

    if column not in frame:
        return _empty()
    if column == "Dividends":
        values = pd.to_numeric(frame[column], errors="coerce").dropna()
        values.index = pd.to_datetime(values.index).tz_localize(None).normalize()
        values = values[values > 0]
    else:
        values = _nominal_close(frame.assign(Close=frame[column]))
    if values.empty:
        return _empty()
    converted = _at_final_rates(values, mode, final_fx)
    return converted if column == "Dividends" else converted.dropna()


__all__ = [
    "CachedDailyHistory",
    "SecurityPrices",
    "final_rate_on",
    "final_rates",
    "resolve_decision_prices",
]
