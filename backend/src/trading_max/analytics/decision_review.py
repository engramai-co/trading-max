"""Score each buy and sell against what the price did afterwards.

A decision is one security, one side, one trading day. Its effect is measured in
GBP on split-adjusted closes plus the dividends paid in between:

* a buy is worth amount x ((later close + dividends) / close on the day - 1):
  the outcome of the shares bought against keeping the cash;
* a sell is worth the opposite: positive when the price fell afterwards (the
  sale avoided that loss), negative when it rose or paid dividends (the sale
  gave that up).

A day with both a buy and a sell of the same security (T) is a round trip for
the shares it bought and sold: its result is matched shares x (average sell -
average buy), net of costs, compared with the day's high-low range on the same
shares. Only the difference between the two sides, if any, is scored as a buy or
sell decision.

Decisions are scored after ``HORIZON_DAYS`` trading days and up to the latest
close. Each decision states how many closes followed it and whether its horizon
window is complete, so a decision with no later close is never read as a zero
outcome. Only closes the provider quoted count: a day without one (a holiday, or
today before the close) repeats the close before it and is not an outcome.
A close still waiting for its exchange rate counts as a session, but no window
starts or ends on it until its value in pounds is final.
Closed trades are also compared with selling at the best and worst close while
the position was held.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
import pandas as pd

from trading_max.analytics.decision_prices import SecurityPrices

CALCULATION_VERSION = "decisions-v4"
HORIZON_DAYS = 20
MAX_DECISIONS = 2_000
MAX_ROUND_TRIPS = 500
#: Fills must sit inside the day's range, give or take costs and FX spread, for
#: that range to describe the same quotes; otherwise the range is not shown.
RANGE_TOLERANCE = 0.1


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def _close_on(closes: pd.Series, day: pd.Timestamp) -> tuple[int, float] | None:
    position = int(closes.index.searchsorted(day, side="right")) - 1
    if position < 0:
        return None
    return position, float(closes.iloc[position])


def _market_close(market: pd.Series, day: pd.Timestamp) -> float | None:
    """The benchmark's close as of a security's close, once the benchmark has one.

    A day after the benchmark's latest close has none yet: its session, or its
    value in pounds, is still to come. A day it did not trade takes its close before.
    """

    if day > market.index.max():
        return None
    found = _close_on(market, day)
    return None if found is None or found[1] <= 0 else found[1]


def _dividends(security: SecurityPrices, start: int, end: int) -> float | None:
    """Dividends per share with an ex-date after close index start, up to end.

    None while one of them has no final value in pounds yet.
    """

    if security.dividends.empty:
        return 0.0
    after = security.closes.index[start]
    until = security.closes.index[end]
    paid = security.dividends[
        (security.dividends.index > after) & (security.dividends.index <= until)
    ]
    return None if paid.isna().any() else float(paid.sum())


def _window(
    security: SecurityPrices, position: int, close: float, end: pd.Timestamp
) -> tuple[float | None, float | None]:
    """The return from the close at position to the close on end, and its dividends."""

    ending = int(security.closes.index.searchsorted(end))
    paid = _dividends(security, position, ending)
    if paid is None:
        return None, None
    return (float(security.closes.iloc[ending]) + paid) / close - 1.0, paid


def _on_day(series: pd.Series, day: pd.Timestamp) -> float | None:
    if series.empty or day not in series.index:
        return None
    value = series.loc[day]
    value = float(value.iloc[-1] if isinstance(value, pd.Series) else value)
    return value if np.isfinite(value) else None


def _side_summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    evaluated = [row for row in rows if row["effect_horizon_gbp"] is not None]
    return {
        "count": len(rows),
        "evaluated": len(evaluated),
        "favourable": sum(1 for row in evaluated if row["effect_horizon_gbp"] > 0),
        "effect_horizon_gbp": _round(sum(row["effect_horizon_gbp"] for row in evaluated)),
        "effect_to_date_gbp": _round(
            sum(row["effect_to_date_gbp"] for row in rows if row["effect_to_date_gbp"] is not None)
        ),
        "amount_gbp": _round(sum(row["amount_gbp"] for row in rows)),
    }


def _campaigns(
    campaigns: Sequence[Mapping[str, Any]],
    prices_by_ticker: Mapping[str, SecurityPrices],
) -> list[dict[str, Any]]:
    result = []
    for campaign in campaigns:
        ticker = str(campaign.get("Ticker") or "").strip().upper()
        prices = prices_by_ticker.get(ticker)
        actual = campaign.get("NetResult")
        invested = campaign.get("BuyNotional")
        start = pd.to_datetime(campaign.get("Start"), utc=True, errors="coerce")
        end = pd.to_datetime(campaign.get("End"), utc=True, errors="coerce")
        if prices is None or actual is None or not invested or pd.isna(start) or pd.isna(end):
            continue
        first = start.tz_convert("UTC").tz_localize(None).normalize()
        last = end.tz_convert("UTC").tz_localize(None).normalize()
        held = prices.closes[(prices.closes.index >= first) & (prices.closes.index <= last)]
        opening = _close_on(prices.closes, first)
        if held.empty or opening is None or opening[1] <= 0:
            continue
        base = opening[1]
        best = float(invested) * (float(held.max()) / base - 1.0)
        worst = float(invested) * (float(held.min()) / base - 1.0)
        result.append(
            {
                "ticker": ticker,
                "name": str(campaign.get("Name") or ticker),
                "start": first.date().isoformat(),
                "end": last.date().isoformat(),
                "invested_gbp": _round(float(invested)),
                "actual_gbp": _round(float(actual)),
                "best_exit_gbp": _round(best),
                "best_exit_date": held.idxmax().date().isoformat(),
                "worst_close_gbp": _round(worst),
                "worst_close_date": held.idxmin().date().isoformat(),
                # What the trade left on the table against its best close.
                "given_back_gbp": _round(max(best - float(actual), 0.0)),
            }
        )
    result.sort(key=lambda row: (-(row["given_back_gbp"] or 0.0), row["end"]))
    return result


def build_decision_review(
    trades: pd.DataFrame,
    prices: Mapping[str, SecurityPrices],
    *,
    campaigns: Sequence[Mapping[str, Any]] = (),
    unpriced: Sequence[str] = (),
    as_of: pd.Timestamp,
    market: pd.Series | None = None,
) -> dict[str, Any]:
    """``trades`` carries NAV trade columns plus ``TotalGBP`` settlement amounts.

    ``market`` is an optional benchmark close series in GBP; each decision then
    records the benchmark's change over the same window, to separate the
    market's move from the security's own. The window runs between the
    security's own closes, and its change is withheld until the benchmark has a
    close for the window's last day.
    """

    fills = trades[
        trades["Action"].astype(str).str.contains(r"buy|sell", case=False, regex=True)
        & trades["SecurityIdentity"].notna()
    ].copy()
    fills["Side"] = (
        fills["Action"]
        .astype(str)
        .str.lower()
        .map(lambda action: "buy" if "buy" in action else "sell")
    )
    fills["AmountGBP"] = pd.to_numeric(fills.get("TotalGBP"), errors="coerce").abs()
    fills["SharesN"] = pd.to_numeric(fills.get("Shares"), errors="coerce").abs()
    decisions: list[dict[str, Any]] = []
    round_trips: list[dict[str, Any]] = []
    unscored = 0
    for (identity, day), day_rows in fills.groupby(["SecurityIdentity", "BusinessDate"], sort=True):
        security = prices.get(identity)
        legs = {
            side: (
                float(rows["AmountGBP"].sum(skipna=True)),
                float(rows["SharesN"].sum(skipna=True)),
            )
            for side, rows in day_rows.groupby("Side", sort=True)
        }
        if security is None:
            unscored += len(legs)
            continue
        start = _close_on(security.closes, pd.Timestamp(day))
        if start is None or start[1] <= 0:
            unscored += len(legs)
            continue
        stamp = pd.Timestamp(day)
        stamp = (stamp.tz_convert("UTC").tz_localize(None) if stamp.tz else stamp).normalize()
        traded_both = len(legs) > 1
        if traded_both:
            (buy_amount, buy_shares), (sell_amount, sell_shares) = legs["buy"], legs["sell"]
            if min(buy_amount, buy_shares, sell_amount, sell_shares) > 0:
                matched = min(buy_shares, sell_shares)
                buy_price = buy_amount / buy_shares
                sell_price = sell_amount / sell_shares
                high = _on_day(security.highs, stamp)
                low = _on_day(security.lows, stamp)
                plausible = (
                    high is not None
                    and low is not None
                    and 0 < low <= high
                    and min(buy_price, sell_price) >= low * (1 - RANGE_TOLERANCE)
                    and max(buy_price, sell_price) <= high * (1 + RANGE_TOLERANCE)
                )
                round_trips.append(
                    {
                        "date": stamp.date().isoformat(),
                        "ticker": security.ticker,
                        "name": security.name,
                        "matched_quantity": _round(matched, 6),
                        "buy_average_gbp": _round(buy_price, 4),
                        "sell_average_gbp": _round(sell_price, 4),
                        "result_gbp": _round(matched * (sell_price - buy_price)),
                        # The most the same shares could take within the day's range.
                        "range_gbp": _round(matched * (high - low)) if plausible else None,
                    }
                )
                # Only the shares bought or sold beyond the round trip are a decision.
                legs = (
                    {"buy": ((buy_shares - matched) * buy_price, buy_shares - matched)}
                    if buy_shares > matched
                    else {"sell": ((sell_shares - matched) * sell_price, sell_shares - matched)}
                    if sell_shares > matched
                    else {}
                )
        position, close = start
        day_of = security.closes.index[position]
        quoted, final = security.quoted, security.final_days
        following = security.closes_after(day_of)
        own = quoted[quoted <= day_of]
        # Until the decision's own close has a final value in pounds there is
        # nothing to measure from: it is observing, like one made today.
        valued = len(own) > 0 and own[-1] in final
        observed = int((following <= final[-1]).sum()) if valued else 0
        horizon_day = following[HORIZON_DAYS - 1] if len(following) >= HORIZON_DAYS else None
        horizon_return = paid_horizon = latest_return = paid_to_date = None
        if valued and horizon_day is not None and horizon_day in final:
            horizon_return, paid_horizon = _window(security, position, close, horizon_day)
        if valued:
            latest_return, paid_to_date = _window(security, position, close, final[-1])
        market_horizon = market_to_date = None
        if market is not None and not market.empty and valued:
            # Both windows run between the security's own closes, not the days
            # its last close is carried across.
            opening = _market_close(market, own[-1])
            if opening is not None:
                if latest_return is not None:
                    closing = _market_close(market, final[-1])
                    market_to_date = None if closing is None else closing / opening - 1.0
                if horizon_return is not None:
                    ending = _market_close(market, horizon_day)
                    market_horizon = None if ending is None else ending / opening - 1.0
        for side, (amount, shares) in legs.items():
            if not amount:
                unscored += 1
                continue
            sign = 1.0 if side == "buy" else -1.0
            decisions.append(
                {
                    "date": stamp.date().isoformat(),
                    "ticker": security.ticker,
                    "name": security.name,
                    "side": side,
                    "kind": "T" if traded_both else side[0].upper(),
                    "quantity": _round(shares, 6),
                    "amount_gbp": _round(amount),
                    "return_horizon": _round(horizon_return, 6),
                    "effect_horizon_gbp": None
                    if horizon_return is None
                    else _round(sign * amount * horizon_return),
                    "return_to_date": _round(latest_return, 6),
                    "effect_to_date_gbp": None
                    if latest_return is None
                    else _round(sign * amount * latest_return),
                    # The dividend part of each effect, already included above.
                    "dividend_horizon_gbp": None
                    if paid_horizon is None
                    else _round(sign * amount * paid_horizon / close),
                    "dividend_to_date_gbp": None
                    if paid_to_date is None
                    else _round(sign * amount * paid_to_date / close),
                    # The benchmark's change over the same window, in GBP.
                    "market_return_horizon": _round(market_horizon, 6),
                    "market_return_to_date": _round(market_to_date, 6),
                    # Quoted closes after the decision's own, through the latest
                    # final one: an unchanged price after several days is still an
                    # outcome, a repeated one is not.
                    "observed_days": observed,
                    "horizon_complete": horizon_return is not None,
                }
            )
    decisions.sort(key=lambda row: (row["date"], row["ticker"], row["side"]))
    round_trips.sort(key=lambda row: (row["date"], row["ticker"]))
    prices_by_ticker = {security.ticker: security for security in prices.values()}
    ranged = [row for row in round_trips if row["range_gbp"] is not None]
    return {
        "calculation_version": CALCULATION_VERSION,
        "as_of": pd.Timestamp(as_of).date().isoformat(),
        "horizon_days": HORIZON_DAYS,
        "coverage": {
            "decisions": len(decisions) + unscored,
            "scored": len(decisions),
            "unpriced_tickers": list(unpriced),
        },
        "buys": _side_summary([row for row in decisions if row["side"] == "buy"]),
        "sells": _side_summary([row for row in decisions if row["side"] == "sell"]),
        "decisions": decisions[-MAX_DECISIONS:],
        "round_trips": round_trips[-MAX_ROUND_TRIPS:],
        "round_trip_summary": {
            "count": len(round_trips),
            "favourable": sum(1 for row in round_trips if (row["result_gbp"] or 0) > 0),
            "result_gbp": _round(sum(row["result_gbp"] or 0.0 for row in round_trips)),
            "ranged": len(ranged),
            "ranged_result_gbp": _round(sum(row["result_gbp"] or 0.0 for row in ranged)),
            "range_gbp": _round(sum(row["range_gbp"] for row in ranged)),
        },
        "closed_trades": _campaigns(campaigns, prices_by_ticker),
    }


__all__ = ["CALCULATION_VERSION", "HORIZON_DAYS", "build_decision_review"]
