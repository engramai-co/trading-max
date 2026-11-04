from __future__ import annotations

import math
from collections.abc import Mapping
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


def _usd_fill(time: str, action: str, shares: float, total_gbp: float) -> dict:
    """A US listing quoted in dollars and settled in pounds, at 1.25 dollars per pound."""

    return {
        **_fill(time, action, shares, total_gbp),
        "Price / share": total_gbp / shares * 1.25,
        "Currency (Price / share)": "USD",
    }


def _review_from_quotes(
    fills: list[dict], listings: Mapping[str, pd.Series], *, viewed: str
) -> dict:
    """Review fills as the stage does on the day viewed, through the price resolver.

    Each listing quotes only the days in its series, so a day its market is shut
    or has not closed yet is a gap the resolver carries the previous close across.
    """

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame({"Close": 1.25}, index=pd.bdate_range(start, end))
        if symbol not in listings:
            raise ValueError("unknown listing")
        quotes = listings[symbol]
        return pd.DataFrame(
            {"Close": quotes[quotes.index <= pd.Timestamp(end)], "Stock Splits": 0.0}
        )

    trades = _trade_columns(pd.DataFrame(fills))
    prices, unpriced = resolve_decision_prices(
        trades, end_day=pd.Timestamp(viewed), history_loader=loader
    )
    assert unpriced == []
    return build_decision_review(trades, prices, as_of=pd.Timestamp(viewed))


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


def test_recent_decisions_wait_for_their_horizon_and_a_t_day_scores_only_its_remainder() -> None:
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
    # One share went round trip at 101/101; the second share bought is the decision.
    (remainder,) = review["decisions"]
    assert (remainder["side"], remainder["kind"], remainder["quantity"]) == ("buy", "T", 1.0)
    assert remainder["amount_gbp"] == pytest.approx(101.0)
    assert remainder["effect_horizon_gbp"] is None
    assert review["buys"]["evaluated"] == 0
    assert review["buys"]["effect_to_date_gbp"] == pytest.approx(101 * (103 / 101 - 1), abs=0.01)
    (trip,) = review["round_trips"]
    assert (trip["matched_quantity"], trip["result_gbp"]) == (1.0, 0.0)
    assert trip["range_gbp"] is None  # no daily high and low for this security


def test_round_trip_result_is_compared_with_the_days_range() -> None:
    closes = _closes("2026-03-02", [100.0, 103.0, 104.0])
    highs = pd.Series([101.0, 106.0, 105.0], index=closes.index)
    lows = pd.Series([99.0, 99.0, 102.0], index=closes.index)
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-03-03T14:00:00Z", "Market buy", 10, 1_000),
                _fill("2026-03-03T19:00:00Z", "Market sell", 10, 1_040),
            ]
        )
    )
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {
            identity: SecurityPrices(
                identity, "NVDA", "NVDA Inc", "NVDA", closes, highs=highs, lows=lows
            )
        },
        as_of=closes.index[-1],
    )
    # A full round trip leaves no directional decision.
    assert review["decisions"] == []
    (trip,) = review["round_trips"]
    assert trip["result_gbp"] == pytest.approx(40.0)
    assert trip["range_gbp"] == pytest.approx(70.0)  # 10 shares x (106 - 99)
    assert review["round_trip_summary"] == {
        "count": 1,
        "favourable": 1,
        "result_gbp": 40.0,
        "ranged": 1,
        "ranged_result_gbp": 40.0,
        "range_gbp": 70.0,
    }


def test_decisions_count_the_closes_that_followed_them() -> None:
    # A flat price after a decision is an outcome, not a decision still waiting:
    # what counts is how many closes followed it. 19 Jan is a market holiday.
    days = pd.bdate_range("2026-01-05", periods=27).drop(pd.Timestamp("2026-01-19"))
    closes = pd.Series(100.0, index=days)
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-01-05T15:00:00Z", "Market buy", 10, 1_000),
                # A weekend order books on Friday, the last business day.
                _fill("2026-01-10T11:00:00Z", "Market buy", 2, 200),
                # On the holiday the decision is measured from the close before it.
                _fill("2026-01-19T15:00:00Z", "Market sell", 5, 500),
                # The latest close: nothing follows it yet.
                _fill("2026-02-10T15:00:00Z", "Market buy", 1, 100),
            ]
        )
    )
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {identity: SecurityPrices(identity, "NVDA", "NVDA Inc", "NVDA", closes)},
        as_of=closes.index[-1],
    )
    observed = {
        row["date"]: (row["observed_days"], row["horizon_complete"], row["effect_horizon_gbp"])
        for row in review["decisions"]
    }
    assert observed == {
        "2026-01-05": (25, True, 0.0),
        "2026-01-09": (21, True, 0.0),
        "2026-01-19": (16, False, None),
        "2026-02-10": (0, False, None),
    }
    # Unchanged prices still score: the two settled buys count, neither helped.
    assert (review["buys"]["evaluated"], review["buys"]["favourable"]) == (2, 0)
    assert all(row["return_to_date"] == 0.0 for row in review["decisions"])


@pytest.mark.parametrize(
    ("monday_closed", "observed", "return_to_date"), [(False, 0, 0.0), (True, 1, 0.04)]
)
def test_a_friday_decision_counts_monday_only_once_monday_has_closed(
    monday_closed: bool, observed: int, return_to_date: float
) -> None:
    # Viewed on Monday 2 Nov. Until New York closes the listing has no Monday
    # quote, and the row that repeats Friday's close is not an outcome.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-12", "2026-10-30"))
    if monday_closed:
        quotes[pd.Timestamp("2026-11-02")] = 130.0
    review = _review_from_quotes(
        [_usd_fill("2026-10-30T15:00:00Z", "Market buy", 10, 1_000)],
        {"NVDA": quotes},
        viewed="2026-11-02",
    )
    (friday,) = review["decisions"]
    assert (friday["observed_days"], friday["horizon_complete"]) == (observed, False)
    assert friday["return_to_date"] == pytest.approx(return_to_date)
    assert friday["effect_horizon_gbp"] is None


def test_a_london_bank_holiday_is_not_a_close() -> None:
    # London is shut on Monday 31 Aug 2026, so the listing has no quote that day.
    days = pd.bdate_range("2026-08-10", "2026-09-30").drop(pd.Timestamp("2026-08-31"))
    quotes = pd.Series(100.0, index=days)  # pence
    quotes[days >= "2026-09-28"] = 110.0
    fills = [
        _fill("2026-08-28T10:00:00Z", "Market buy", 1_000, 1_000, "VOD"),
        # An order on the holiday is measured from Friday's close.
        _fill("2026-08-31T10:00:00Z", "Market sell", 500, 500, "VOD"),
    ]
    on_the_holiday = _review_from_quotes(fills, {"VOD.L": quotes}, viewed="2026-08-31")
    assert [row["observed_days"] for row in on_the_holiday["decisions"]] == [0, 0]
    friday, holiday = _review_from_quotes(fills, {"VOD.L": quotes}, viewed="2026-09-30")[
        "decisions"
    ]
    # September's 22 closes follow both decisions; the holiday is not one of them.
    assert (friday["observed_days"], holiday["observed_days"]) == (22, 22)
    assert friday["horizon_complete"] and holiday["horizon_complete"]
    # Both horizons end on the 20th close, 28 Sep, not the 20th weekday, 25 Sep.
    assert friday["return_horizon"] == pytest.approx(0.1)
    assert holiday["effect_horizon_gbp"] == pytest.approx(-50.0)


def test_a_new_york_holiday_is_not_a_close() -> None:
    # New York is shut on Thanksgiving, Thursday 27 Nov 2025.
    days = pd.bdate_range("2025-11-10", "2025-11-28").drop(pd.Timestamp("2025-11-27"))
    quotes = pd.Series(125.0, index=days)
    quotes[pd.Timestamp("2025-11-28")] = 137.5
    fills = [_usd_fill("2025-11-26T16:00:00Z", "Market buy", 10, 1_000)]
    (on_the_holiday,) = _review_from_quotes(fills, {"NVDA": quotes}, viewed="2025-11-27")[
        "decisions"
    ]
    (next_day,) = _review_from_quotes(fills, {"NVDA": quotes}, viewed="2025-11-28")["decisions"]
    assert on_the_holiday["observed_days"] == 0
    assert next_day["observed_days"] == 1
    assert next_day["effect_to_date_gbp"] == pytest.approx(100.0)


def test_decisions_on_the_latest_close_wait_for_the_next_one() -> None:
    # Decisions from Tuesday 3 Nov, viewed at 15:10 London on 4 Nov: neither London
    # nor New York has closed, so each decision's own close is still the latest.
    days = pd.bdate_range("2026-10-19", "2026-11-03")
    listings = {"NVDA": pd.Series(125.0, index=days), "VOD.L": pd.Series(100.0, index=days)}
    fills = [
        _usd_fill("2026-11-03T15:00:00Z", "Market buy", 10, 1_000),
        _fill("2026-11-03T10:00:00Z", "Market sell", 1_000, 1_000, "VOD"),
        # An order today is measured from Tuesday's close; nothing follows it either.
        _usd_fill("2026-11-04T14:45:00Z", "Market buy", 1, 100),
    ]
    review = _review_from_quotes(fills, listings, viewed="2026-11-04")
    assert [(row["date"], row["ticker"]) for row in review["decisions"]] == [
        ("2026-11-03", "NVDA"),
        ("2026-11-03", "VOD"),
        ("2026-11-04", "NVDA"),
    ]
    assert [row["observed_days"] for row in review["decisions"]] == [0, 0, 0]
    assert not any(row["horizon_complete"] for row in review["decisions"])
    assert (review["buys"]["evaluated"], review["sells"]["evaluated"]) == (0, 0)


def test_a_flat_price_after_many_closes_is_a_scored_zero() -> None:
    quotes = pd.Series(100.0, index=pd.bdate_range("2026-01-19", "2026-03-13"))  # pence
    review = _review_from_quotes(
        [_fill("2026-02-02T10:00:00Z", "Market buy", 1_000, 1_000, "VOD")],
        {"VOD.L": quotes},
        viewed="2026-03-13",
    )
    (buy,) = review["decisions"]
    assert (buy["observed_days"], buy["horizon_complete"]) == (29, True)
    assert (buy["effect_horizon_gbp"], buy["effect_to_date_gbp"]) == (0.0, 0.0)
    # A genuine zero: evaluated, and not counted as helping.
    assert (review["buys"]["evaluated"], review["buys"]["favourable"]) == (1, 0)


def test_dividends_after_a_decision_count_in_its_effect() -> None:
    closes = _closes("2026-01-05", [100.0] * 30)
    dividends = pd.Series([2.0], index=[closes.index[3]])
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-01-05T15:00:00Z", "Market buy", 10, 1_000),
                _fill("2026-01-05T15:00:00Z", "Market buy", 5, 500, "AMD"),
            ]
        )
    )
    nvda, amd = trades["SecurityIdentity"].iloc[0], trades["SecurityIdentity"].iloc[1]
    review = build_decision_review(
        trades,
        {
            nvda: SecurityPrices(nvda, "NVDA", "NVDA Inc", "NVDA", closes, dividends=dividends),
            amd: SecurityPrices(amd, "AMD", "AMD Inc", "AMD", closes),
        },
        as_of=closes.index[-1],
    )
    rows = {row["ticker"]: row for row in review["decisions"]}
    # A flat price plus a 2.00 dividend: +2% on £1,000, all of it from the dividend.
    assert rows["NVDA"]["effect_horizon_gbp"] == pytest.approx(20.0)
    assert rows["NVDA"]["dividend_horizon_gbp"] == pytest.approx(20.0)
    assert rows["NVDA"]["effect_to_date_gbp"] == pytest.approx(20.0)
    assert rows["AMD"]["effect_horizon_gbp"] == pytest.approx(0.0)
    assert rows["AMD"]["dividend_to_date_gbp"] == pytest.approx(0.0)


def test_a_sale_gives_up_the_dividends_that_followed() -> None:
    closes = _closes("2026-01-05", [100.0] * 30)
    dividends = pd.Series([1.5], index=[closes.index[10]])
    trades = _trade_columns(pd.DataFrame([_fill("2026-01-05T15:00:00Z", "Market sell", 10, 1_000)]))
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {
            identity: SecurityPrices(
                identity, "NVDA", "NVDA Inc", "NVDA", closes, dividends=dividends
            )
        },
        as_of=closes.index[-1],
    )
    (sale,) = review["decisions"]
    assert sale["effect_horizon_gbp"] == pytest.approx(-15.0)
    assert sale["dividend_horizon_gbp"] == pytest.approx(-15.0)


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


def test_cache_keeps_dividends_and_ranges_and_refetches_an_older_format(tmp_path) -> None:
    calls: list[date] = []

    def fetch(symbol: str, start: date, end: date) -> pd.DataFrame:
        calls.append(start)
        index = pd.bdate_range(start, end)
        dividends = pd.Series(0.0, index=index)
        dividends.iloc[2] = 0.25
        return pd.DataFrame(
            {"Close": 10.0, "Stock Splits": 0.0, "Dividends": dividends, "High": 11.0, "Low": 9.5},
            index=index,
        )

    now = pd.Timestamp("2026-03-02T12:00:00Z").to_pydatetime()
    cache = CachedDailyHistory(tmp_path, fetch=fetch, now=lambda: now)
    # A cache written before dividends and ranges were kept.
    old = tmp_path / (cache._path("AAA").name)
    old.write_text(
        '{"symbol": "AAA", "start": "2026-01-01", "end": "2026-02-27", '
        '"fetched_at": "2026-03-02T11:00:00+00:00", "rows": [["2026-01-02", 10.0, 0.0]]}'
    )
    frame = cache("AAA", date(2026, 1, 1), date(2026, 2, 27))
    assert calls == [date(2026, 1, 1)]
    assert float(frame["Dividends"].iloc[2]) == 0.25
    assert (float(frame["High"].iloc[0]), float(frame["Low"].iloc[0])) == (11.0, 9.5)
    cache("AAA", date(2026, 1, 1), date(2026, 2, 27))
    assert len(calls) == 1


def test_resolution_converts_dividends_and_ranges_like_the_closes() -> None:
    days = pd.bdate_range("2026-01-01", "2026-02-27")

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame({"Close": 1.25}, index=days)
        if symbol == "NVDA.L":
            dividends = pd.Series(0.0, index=days)
            dividends[pd.Timestamp("2026-02-02")] = 150.0  # pence
            return pd.DataFrame(
                {
                    "Close": 20_000.0,
                    "Stock Splits": 0.0,
                    "Dividends": dividends,
                    "High": 20_500.0,
                    "Low": 19_800.0,
                },
                index=days,
            )
        raise ValueError("unknown listing")

    trades = _trade_columns(pd.DataFrame([_fill("2026-01-20T12:00:00Z", "Market buy", 5, 1_000)]))
    prices, _ = resolve_decision_prices(
        trades, end_day=pd.Timestamp("2026-02-27"), history_loader=loader
    )
    security = next(iter(prices.values()))
    assert security.dividends.to_dict() == {pd.Timestamp("2026-02-02"): pytest.approx(1.5)}
    assert security.highs.loc["2026-01-20"] == pytest.approx(205.0)
    assert security.lows.loc["2026-01-20"] == pytest.approx(198.0)


def test_highs_and_lows_are_restored_to_the_quotes_of_the_day_after_a_split() -> None:
    days = pd.bdate_range("2026-01-01", "2026-02-27")
    splits = pd.Series(0.0, index=days)
    splits[pd.Timestamp("2026-02-02")] = 2.0

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame({"Close": 1.25}, index=days)
        if symbol == "NVDA.L":
            # Split-adjusted pence; quotes before the 2:1 split were twice as high.
            return pd.DataFrame(
                {"Close": 10_000.0, "Stock Splits": splits, "High": 10_250.0, "Low": 9_900.0},
                index=days,
            )
        raise ValueError("unknown listing")

    trades = _trade_columns(pd.DataFrame([_fill("2026-01-20T12:00:00Z", "Market buy", 5, 1_000)]))
    prices, _ = resolve_decision_prices(
        trades, end_day=pd.Timestamp("2026-02-27"), history_loader=loader
    )
    security = next(iter(prices.values()))
    # £200 fills sit inside the restored £198-£205 range of that day.
    assert security.highs.loc["2026-01-20"] == pytest.approx(205.0)
    assert security.lows.loc["2026-01-20"] == pytest.approx(198.0)
    assert security.highs.loc["2026-02-10"] == pytest.approx(102.5)


def test_a_range_that_does_not_contain_the_fills_is_not_shown() -> None:
    closes = _closes("2026-03-02", [100.0, 103.0, 104.0])
    wrong = pd.Series(60.0, index=closes.index)
    trades = _trade_columns(
        pd.DataFrame(
            [
                _fill("2026-03-03T14:00:00Z", "Market buy", 10, 1_000),
                _fill("2026-03-03T19:00:00Z", "Market sell", 10, 1_040),
            ]
        )
    )
    identity = trades["SecurityIdentity"].iloc[0]
    review = build_decision_review(
        trades,
        {
            identity: SecurityPrices(
                identity, "NVDA", "NVDA Inc", "NVDA", closes, highs=wrong, lows=wrong * 0.9
            )
        },
        as_of=closes.index[-1],
    )
    assert review["round_trips"][0]["range_gbp"] is None
    assert review["round_trip_summary"]["ranged"] == 0
