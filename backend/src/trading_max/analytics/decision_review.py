"""Score each buy and sell against what the price did afterwards.

A decision is one security, one side, one trading day. Its effect is measured in
GBP on split-adjusted closes:

* a buy is worth ``amount x (later close / close on the day - 1)``: the
  outcome of the shares bought against keeping the cash;
* a sell is worth the opposite: positive when the price fell afterwards (the
  sale avoided that loss), negative when it rose (the sale gave that gain up).

Decisions are scored after ``HORIZON_DAYS`` trading days and up to the latest
close. Closed trades are also compared with selling at the best and worst close
while the position was held. Dividends are not included.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pandas as pd

from trading_max.analytics.decision_prices import SecurityPrices

CALCULATION_VERSION = "decisions-v1"
HORIZON_DAYS = 20
MAX_DECISIONS = 2_000


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def _close_on(closes: pd.Series, day: pd.Timestamp) -> tuple[int, float] | None:
    position = int(closes.index.searchsorted(day, side="right")) - 1
    if position < 0:
        return None
    return position, float(closes.iloc[position])


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
) -> dict[str, Any]:
    """``trades`` carries NAV trade columns plus ``TotalGBP`` settlement amounts."""

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
    both_sides = fills.groupby(["SecurityIdentity", "BusinessDate"])["Side"].nunique()
    decisions: list[dict[str, Any]] = []
    unscored = 0
    for (identity, day, side), rows in fills.groupby(
        ["SecurityIdentity", "BusinessDate", "Side"], sort=True
    ):
        security = prices.get(identity)
        amount = float(rows["AmountGBP"].sum(skipna=True))
        if security is None or not amount:
            unscored += 1
            continue
        start = _close_on(security.closes, pd.Timestamp(day))
        if start is None or start[1] <= 0:
            unscored += 1
            continue
        position, close = start
        horizon = position + HORIZON_DAYS
        later = float(security.closes.iloc[horizon]) if horizon < len(security.closes) else None
        latest = float(security.closes.iloc[-1])
        sign = 1.0 if side == "buy" else -1.0
        horizon_return = None if later is None else later / close - 1.0
        latest_return = latest / close - 1.0
        decisions.append(
            {
                "date": pd.Timestamp(day).date().isoformat(),
                "ticker": security.ticker,
                "name": security.name,
                "side": side,
                "kind": "T" if both_sides.get((identity, day), 1) > 1 else side[0].upper(),
                "quantity": _round(float(rows["SharesN"].sum(skipna=True)), 6),
                "amount_gbp": _round(amount),
                "return_horizon": _round(horizon_return, 6),
                "effect_horizon_gbp": None
                if horizon_return is None
                else _round(sign * amount * horizon_return),
                "return_to_date": _round(latest_return, 6),
                "effect_to_date_gbp": _round(sign * amount * latest_return),
            }
        )
    decisions.sort(key=lambda row: (row["date"], row["ticker"], row["side"]))
    prices_by_ticker = {security.ticker: security for security in prices.values()}
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
        "closed_trades": _campaigns(campaigns, prices_by_ticker),
    }


__all__ = ["CALCULATION_VERSION", "HORIZON_DAYS", "build_decision_review"]
