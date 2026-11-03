from __future__ import annotations

import math
from datetime import date, timedelta

import pandas as pd
import pytest
from trading_max.analytics.decision_prices import (
    CachedDailyHistory,
    SecurityPrices,
    resolve_decision_prices,
)
from trading_max.analytics.decision_review import HORIZON_DAYS, build_decision_review
from trading_max.analytics.historical_nav import _trade_columns


def _closes(start: str, values: list[float]) -> pd.Series:
    return pd.Series(values, index=pd.bdate_range(start, periods=len(values)), dtype=float)


def _fill(time: str, action: str, shares: float, total_gbp: float, ticker: str = "NVDA") -> dict:
    return {
        "Time": pd.Timestamp(time, tz="UTC"),
        "Action": action,
        "Ticker": ticker,
        "Name": ticker + " Inc",
        "ISIN": "US0000000001" if ticker == "NVDA" else "US0000000002",
        "Shares": shares,
        "TotalN": total_gbp,
        "TotalGBP": total_gbp,
        "Price / share": total_gbp / shares,
        "Exchange rate": 1.0,
        "Currency (Price / share)": "GBP",
        "Currency (Total)": "GBP",
    }


def test_sells_and_buys_are_scored_against_the_price_that_followed() -> None:
    # 100 on the buy day, 120 on the sell day, 150 twenty trading days later, 90 at the end.
    path = [100.0] * 5 + [120.0] * 5 + [150.0] * 25 + [90.0]
    closes = _closes("2026-01-05", path)
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-01-05T15:00:00Z", "Market buy", 10, 1_000),
                _fill("2026-01-12T15:00:00Z", "Market sell", 10, 1_200),
            ]
        )
    )
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {identity: SecurityPrices(identity, "NVDA", "NVDA Inc", "NVDA", closes)},
        as_of=closes.index[-1],
    )
    buy, sell = review["decisions"]
    assert (buy["side"], buy["kind"], sell["side"]) == ("buy", "B", "sell")
    # The sale gave up the rise to 150 after twenty trading days: -1200 x 25%.
    assert sell["return_horizon"] == pytest.approx(0.25)
    assert sell["effect_horizon_gbp"] == pytest.approx(-300.0)
    # By the latest close (90) the sale avoided a 25% fall: +1200 x 25%.
    assert sell["effect_to_date_gbp"] == pytest.approx(300.0)
    assert buy["effect_horizon_gbp"] == pytest.approx(1_000 * (150 / 100 - 1))
    assert review["sells"] == {
        "count": 1,
        "evaluated": 1,
        "favourable": 0,
        "effect_horizon_gbp": -300.0,
        "effect_to_date_gbp": 300.0,
        "amount_gbp": 1200.0,
    }
    assert review["horizon_days"] == HORIZON_DAYS


def test_recent_decisions_wait_for_their_horizon_and_same_day_trades_are_t() -> None:
    closes = _closes("2026-03-02", [100.0, 101.0, 102.0, 103.0])
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-03-03T14:00:00Z", "Market buy", 2, 202),
                _fill("2026-03-03T19:00:00Z", "Limit sell", 1, 101),
            ]
        )
    )
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {identity: SecurityPrices(identity, "NVDA", "NVDA Inc", "NVDA", closes)},
        as_of=closes.index[-1],
    )
    assert {row["kind"] for row in review["decisions"]} == {"T"}
    assert all(row["effect_horizon_gbp"] is None for row in review["decisions"])
    assert review["buys"]["evaluated"] == 0
    assert review["buys"]["effect_to_date_gbp"] == pytest.approx(202 * (103 / 101 - 1), abs=0.01)


def test_unpriced_securities_are_counted_not_guessed() -> None:
    trades = _trade_columns(
        pd.DataFrame([_fill("2026-03-03T14:00:00Z", "Market buy", 1, 50, "XYZ")])
    )
    review = build_decision_review(trades, {}, unpriced=["XYZ"], as_of=pd.Timestamp("2026-03-10"))
    assert review["coverage"] == {"decisions": 1, "scored": 0, "unpriced_tickers": ["XYZ"]}
    assert review["decisions"] == []


def test_closed_trades_compare_the_result_with_the_best_and_worst_close() -> None:
    closes = _closes("2026-01-05", [100.0, 140.0, 80.0, 110.0, 110.0])
    review = build_decision_review(
        _trade_columns(pd.DataFrame([_fill("2026-01-05T15:00:00Z", "Market buy", 10, 1_000)])),
        {
            "isin:US0000000001": SecurityPrices(
                "isin:US0000000001", "NVDA", "NVDA Inc", "NVDA", closes
            )
        },
        campaigns=[
            {
                "Ticker": "NVDA",
                "Name": "NVDA Inc",
                "Start": "2026-01-05T15:00:00Z",
                "End": "2026-01-08T15:00:00Z",
                "BuyNotional": 1_000,
                "NetResult": 100,
            }
        ],
        as_of=closes.index[-1],
    )
    trade = review["closed_trades"][0]
    assert trade["best_exit_gbp"] == pytest.approx(400.0)
    assert trade["best_exit_date"] == "2026-01-06"
    assert trade["worst_close_gbp"] == pytest.approx(-200.0)
    assert trade["given_back_gbp"] == pytest.approx(300.0)


def test_resolution_reconciles_listings_with_broker_fills_and_uses_adjusted_closes() -> None:
    days = pd.bdate_range("2026-01-01", "2026-02-27")
    # The right listing quotes in pence; a split on 2 Feb halves later nominal closes.
    adjusted = pd.Series(100.0, index=days)
    adjusted[days >= "2026-02-02"] = 120.0

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame({"Close": 1.25}, index=days)
        if symbol == "NVDA.L":
            splits = pd.Series(0.0, index=days)
            splits[pd.Timestamp("2026-02-02")] = 2.0
            return pd.DataFrame({"Close": adjusted * 100, "Stock Splits": splits}, index=days)
        raise ValueError("unknown listing")

    fills = [_fill("2026-01-20T12:00:00Z", "Market buy", 5, 1_000)]
    trades = _trade_columns(pd.DataFrame(fills))
    prices, unpriced = resolve_decision_prices(
        trades, end_day=pd.Timestamp("2026-02-27"), history_loader=loader
    )
    security = next(iter(prices.values()))
    assert unpriced == []
    assert security.symbol == "NVDA.L"
    # Nominal pence before the split reconcile with £200 fills; returns use adjusted closes.
    assert security.closes.iloc[-1] / security.closes.loc["2026-01-20"] == pytest.approx(1.2)

    requested: list[str] = []

    def counting(symbol: str, start: date, end: date) -> pd.DataFrame:
        requested.append(symbol)
        return loader(symbol, start, end)

    memo = {security.identity: "NVDA.L"}
    resolve_decision_prices(
        trades, end_day=pd.Timestamp("2026-02-27"), history_loader=counting, memo=memo
    )
    # A remembered listing that still reconciles is the only security request.
    assert [symbol for symbol in requested if symbol != "GBPUSD=X"] == ["NVDA.L"]


def test_cache_reuses_history_and_refetches_when_an_overlap_disagrees(tmp_path) -> None:
    calls: list[tuple[date, date]] = []
    level = {"value": 10.0}

    def fetch(symbol: str, start: date, end: date) -> pd.DataFrame:
        calls.append((start, end))
        index = pd.bdate_range(start, end)
        return pd.DataFrame({"Close": level["value"], "Stock Splits": 0.0}, index=index)

    clock = {"now": pd.Timestamp("2026-03-02T12:00:00Z").to_pydatetime()}
    cache = CachedDailyHistory(tmp_path, fetch=fetch, now=lambda: clock["now"])
    first = cache("AAA", date(2026, 1, 1), date(2026, 2, 27))
    again = cache("AAA", date(2026, 1, 5), date(2026, 2, 27))
    assert len(calls) == 1 and len(again) == len(first) - 2
    clock["now"] += timedelta(days=1)
    cache("AAA", date(2026, 1, 1), date(2026, 3, 3))
    assert calls[-1][0] == date(2026, 2, 20)  # only the recent tail
    level["value"] = 5.0  # a back-adjustment changes every earlier close
    clock["now"] += timedelta(days=1)
    refreshed = cache("AAA", date(2026, 1, 1), date(2026, 3, 4))
    assert calls[-1][0] == date(2026, 1, 1)
    assert math.isclose(float(refreshed["Close"].iloc[0]), 5.0)
