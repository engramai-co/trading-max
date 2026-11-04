from __future__ import annotations

import json
import math
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pandas as pd
import pytest
from trading_max.analytics import decision_prices
from trading_max.analytics.decision_prices import (
    CachedDailyHistory,
    SecurityPrices,
    final_rate_on,
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


#: The exchange the provider names for each synthetic listing; others name none.
_EXCHANGES = {"NVDA": "NMS", "VOD.L": "LSE"}


def _review_from_quotes(
    fills: list[dict],
    listings: Mapping[str, pd.Series],
    *,
    viewed: str,
    now: str | None = None,
    rates: pd.Series | None = None,
    market: pd.Series | None = None,
    dividends: Mapping[str, pd.Series] | None = None,
) -> dict:
    """Review fills as the stage does on the day viewed, through the price resolver.

    Each listing quotes only the days in its series: a session of its market that
    is missing from it is a gap the provider left. GBPUSD is 1.25 unless rates are
    given. The review runs at now, by default just after the day viewed, when its
    closes and its exchange rate are all final. A listing's dividends, in its own
    currency, go on their ex-dates.
    """

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            usd = pd.Series(1.25, index=pd.bdate_range(start, end)) if rates is None else rates
            window = (usd.index >= pd.Timestamp(start)) & (usd.index <= pd.Timestamp(end))
            return pd.DataFrame({"Close": usd[window]})
        if symbol not in listings:
            raise ValueError("unknown listing")
        quotes = listings[symbol]
        frame = pd.DataFrame(
            {"Close": quotes[quotes.index <= pd.Timestamp(end)], "Stock Splits": 0.0}
        )
        if dividends and symbol in dividends:
            frame["Dividends"] = dividends[symbol].reindex(frame.index, fill_value=0.0)
        if symbol in _EXCHANGES:
            frame.attrs["exchange"] = _EXCHANGES[symbol]
        return frame

    trades = _trade_columns(pd.DataFrame(fills))
    prices, unpriced = resolve_decision_prices(
        trades,
        end_day=pd.Timestamp(viewed),
        history_loader=loader,
        now=pd.Timestamp(now) if now else pd.Timestamp(viewed, tz="UTC") + pd.Timedelta("24h30min"),
    )
    assert unpriced == []
    return build_decision_review(trades, prices, as_of=pd.Timestamp(viewed), market=market)


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
    review = _review_from_quotes(fills, listings, viewed="2026-11-04", now="2026-11-04T15:10:00Z")
    assert [(row["date"], row["ticker"]) for row in review["decisions"]] == [
        ("2026-11-03", "NVDA"),
        ("2026-11-03", "VOD"),
        ("2026-11-04", "NVDA"),
    ]
    assert [row["observed_days"] for row in review["decisions"]] == [0, 0, 0]
    assert not any(row["horizon_complete"] for row in review["decisions"])
    assert (review["buys"]["evaluated"], review["sells"]["evaluated"]) == (0, 0)


@pytest.mark.parametrize(
    ("now", "closed"), [("2026-11-04T15:10:00Z", False), ("2026-11-04T16:45:00Z", True)]
)
def test_todays_bar_is_a_close_only_once_its_session_has_closed(now: str, closed: bool) -> None:
    # At 15:10 UTC the provider already returns a 4 Nov bar while London trades;
    # it is a close only after 16:30 UTC.
    quotes = pd.Series(100.0, index=pd.bdate_range("2026-09-21", "2026-11-03"))  # pence
    quotes[pd.Timestamp("2026-11-04")] = 110.0
    review = _review_from_quotes(
        [
            # The 20th close after 7 Oct is 4 Nov's.
            _fill("2026-10-07T10:00:00Z", "Market buy", 1_000, 1_000, "VOD"),
            _fill("2026-11-03T10:00:00Z", "Market buy", 100, 100, "VOD"),
        ],
        {"VOD.L": quotes},
        viewed="2026-11-04",
        now=now,
    )
    october, yesterday = review["decisions"]
    assert yesterday["observed_days"] == (1 if closed else 0)
    assert (october["observed_days"], october["horizon_complete"]) == (
        (20, True) if closed else (19, False)
    )
    # The forming bar's +10% is no verdict until the session closes on it.
    assert october["effect_horizon_gbp"] == (pytest.approx(100.0) if closed else None)


@pytest.mark.parametrize(
    ("now", "observed"), [("2025-12-24T12:20:00Z", 0), ("2025-12-24T12:35:00Z", 1)]
)
def test_an_early_close_ends_the_session_at_its_own_time(now: str, observed: int) -> None:
    # London closes at 12:30 on Christmas Eve; on a full day it trades until 16:30.
    review = _review_from_quotes(
        [_fill("2025-12-23T10:00:00Z", "Market buy", 1_000, 1_000, "VOD")],
        {"VOD.L": pd.Series(100.0, index=pd.bdate_range("2025-12-01", "2025-12-24"))},
        viewed="2025-12-24",
        now=now,
    )
    assert review["decisions"][0]["observed_days"] == observed


def test_a_dollar_close_counts_once_that_days_exchange_rate_is_final() -> None:
    # New York closes at 21:00 UTC, but the 4 Nov rate is final only once that day
    # is over: scoring at 21:30 on the 3 Nov rate would change at midnight.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))  # flat in dollars
    rates = pd.Series(1.25, index=quotes.index)
    rates[pd.Timestamp("2026-11-04")] = 1.20
    fills = [_usd_fill("2026-11-03T15:00:00Z", "Market buy", 60, 6_000)]
    evening, after_midnight = (
        _review_from_quotes(fills, {"NVDA": quotes}, viewed="2026-11-04", now=now, rates=rates)[
            "decisions"
        ][0]
        for now in ("2026-11-04T21:30:00Z", "2026-11-05T00:30:00Z")
    )
    assert (evening["observed_days"], evening["effect_to_date_gbp"]) == (0, 0.0)
    # The same dollar close is worth 4.2% more in pounds at the 4 Nov rate.
    assert after_midnight["observed_days"] == 1
    assert after_midnight["effect_to_date_gbp"] == pytest.approx(250.0)


def test_a_close_without_its_own_days_rate_waits_instead_of_borrowing_one() -> None:
    # The provider has no 3 Nov rate until a later, wider fetch fills it at 1.20.
    # Until then 3 Nov's close has no value in pounds: its decision observes
    # rather than scoring £0 at 2 Nov's rate, then -£240 once the rate arrives.
    gap = pd.Timestamp("2026-11-03")
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))  # flat in dollars
    filled = pd.Series(1.25, index=quotes.index)
    filled[gap] = 1.20
    fills = [
        _usd_fill("2026-10-30T15:00:00Z", "Market buy", 60, 6_000),
        _usd_fill("2026-11-03T15:00:00Z", "Market buy", 60, 6_000),
    ]
    before, after = (
        _review_from_quotes(fills, {"NVDA": quotes}, viewed="2026-11-04", rates=rates)["decisions"]
        for rates in (filled.drop(gap), filled)
    )
    assert (before[1]["observed_days"], before[1]["effect_to_date_gbp"]) == (0, None)
    assert after[1]["observed_days"] == 1
    assert after[1]["effect_to_date_gbp"] == pytest.approx(-240.0)
    # A window between final closes does not move when the gap fills.
    assert (after[0]["observed_days"], after[0]["effect_to_date_gbp"]) == (3, 0.0)
    assert before[0] == after[0]


def test_a_horizon_ending_on_a_close_without_its_rate_waits_for_it() -> None:
    # 3 Nov is the 20th close after 6 Oct, and its rate arrives late, at 1.20.
    gap = pd.Timestamp("2026-11-03")
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))
    filled = pd.Series(1.25, index=quotes.index)
    filled[gap] = 1.20
    fills = [_usd_fill("2026-10-06T15:00:00Z", "Market buy", 60, 6_000)]
    (before,), (after,) = (
        _review_from_quotes(fills, {"NVDA": quotes}, viewed="2026-11-04", rates=rates)["decisions"]
        for rates in (filled.drop(gap), filled)
    )
    assert (before["horizon_complete"], before["effect_horizon_gbp"]) == (False, None)
    assert after["horizon_complete"] is True
    assert after["effect_horizon_gbp"] == pytest.approx(250.0)
    # The close still counts while it waits, so the count cannot shift when it arrives.
    assert before["observed_days"] == after["observed_days"] == 21


def test_a_dividend_without_its_days_rate_withholds_the_window_it_falls_in() -> None:
    gap = pd.Timestamp("2026-11-03")
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))
    rates = pd.Series(1.25, index=quotes.index)
    paid = {"NVDA": pd.Series({gap: 1.25})}  # dollars per share, on a day without its rate
    fills = [_usd_fill("2026-10-30T15:00:00Z", "Market buy", 60, 6_000)]
    (before,), (after,) = (
        _review_from_quotes(
            fills, {"NVDA": quotes}, viewed="2026-11-04", rates=known, dividends=paid
        )["decisions"]
        for known in (rates.drop(gap), rates)
    )
    assert before["observed_days"] == after["observed_days"] == 3
    assert (before["effect_to_date_gbp"], before["dividend_to_date_gbp"]) == (None, None)
    assert after["effect_to_date_gbp"] == after["dividend_to_date_gbp"] == pytest.approx(60.0)


def test_an_easter_monday_close_always_takes_thursdays_rate() -> None:
    # New York trades on Easter Monday, a currency-market holiday: Monday's close
    # takes Thursday's rate at once, and a rate the provider publishes for Monday
    # later does not flip the verdict.
    sessions = pd.bdate_range("2025-03-20", "2025-04-25").drop(pd.Timestamp("2025-04-18"))
    quotes = pd.Series(125.0, index=sessions)
    skipped = pd.Series(1.25, index=sessions.drop(pd.Timestamp("2025-04-21")))
    skipped[pd.Timestamp("2025-04-17")] = 1.30
    late = skipped.copy()
    late[pd.Timestamp("2025-04-21")] = 1.20
    fills = [_usd_fill("2025-04-21T15:00:00Z", "Market buy", 60, 6_000)]

    def review(rates: pd.Series, viewed: str, now: str) -> dict:
        found = _review_from_quotes(fills, {"NVDA": quotes}, viewed=viewed, now=now, rates=rates)
        return found["decisions"][0]

    evening = review(skipped, "2025-04-21", "2025-04-21T21:30:00Z")
    assert (evening["observed_days"], evening["effect_to_date_gbp"]) == (0, 0.0)
    before, after = (
        review(rates, "2025-04-22", "2025-04-23T00:30:00Z") for rates in (skipped, late)
    )
    assert before["observed_days"] == after["observed_days"] == 1
    assert before["effect_to_date_gbp"] == after["effect_to_date_gbp"] == pytest.approx(240.0)


def test_a_holiday_close_takes_the_last_final_rate_past_one_still_pending() -> None:
    # Thursday 17 Apr 2025's rate is missing, still pending once Tuesday's is final.
    # Easter Monday's close takes Wednesday's, the last final rate before the
    # holiday, while Thursday's own close keeps waiting for its rate.
    sessions = pd.bdate_range("2025-03-20", "2025-04-25").drop(pd.Timestamp("2025-04-18"))
    quotes = pd.Series(125.0, index=sessions)
    rates = pd.Series(1.25, index=sessions.drop(pd.to_datetime(["2025-04-17", "2025-04-21"])))
    rates[pd.Timestamp("2025-04-16")] = 1.30
    fills = [
        _usd_fill("2025-04-17T15:00:00Z", "Market buy", 60, 6_000),
        _usd_fill("2025-04-21T15:00:00Z", "Market buy", 60, 6_000),
    ]
    thursday, monday = _review_from_quotes(
        fills, {"NVDA": quotes}, viewed="2025-04-22", now="2025-04-23T00:30:00Z", rates=rates
    )["decisions"]
    assert (thursday["observed_days"], thursday["effect_to_date_gbp"]) == (0, None)
    assert monday["observed_days"] == 1
    assert monday["effect_to_date_gbp"] == pytest.approx(240.0)


def test_an_expired_price_gap_settles_past_a_close_still_waiting_for_its_rate() -> None:
    # As above, and the provider has no Easter Monday bar either. Three New York
    # closes later (24 Apr, before midnight) the gap settles on Thursday's close at
    # Monday's own rate, Wednesday's; Thursday's close still waits for its rate,
    # and nothing moves when that rate settles at midnight.
    sessions = pd.bdate_range("2025-03-20", "2025-04-25").drop(pd.Timestamp("2025-04-18"))
    quotes = pd.Series(125.0, index=sessions)
    quotes[pd.Timestamp("2025-04-17")] = 130.0
    quotes[quotes.index >= pd.Timestamp("2025-04-22")] = 137.5
    rates = pd.Series(1.25, index=sessions.drop(pd.to_datetime(["2025-04-17", "2025-04-21"])))
    rates[pd.Timestamp("2025-04-16")] = 1.30
    listing = {"NVDA": quotes.drop(pd.Timestamp("2025-04-21"))}
    fills = [_usd_fill("2025-04-21T15:00:00Z", "Market buy", 60, 6_000)]

    def review(now: str) -> dict:
        found = _review_from_quotes(fills, listing, viewed="2025-04-24", now=now, rates=rates)
        return found["decisions"][0]

    evening, after_midnight = review("2025-04-24T21:30:00Z"), review("2025-04-25T00:30:00Z")
    # 24 Apr's own rate is final only at midnight.
    assert evening["observed_days"] == 2
    assert evening["effect_to_date_gbp"] == pytest.approx(600.0)
    assert after_midnight["observed_days"] == 3
    assert after_midnight["effect_to_date_gbp"] == pytest.approx(600.0)


def test_a_holiday_keeps_the_last_final_rate_and_a_gap_settles_after_three() -> None:
    # Christmas Day 2026 is a Friday: no rate is due from it to the Sunday, and the
    # provider's own Christmas rate is not used.
    days = pd.date_range("2026-12-23", "2026-12-29")
    published = pd.Series(
        [1.25, 1.26, 1.30, 1.27, 1.28],
        index=pd.to_datetime(
            ["2026-12-23", "2026-12-24", "2026-12-25", "2026-12-28", "2026-12-29"]
        ),
    )
    tuesday_night = pd.Timestamp("2026-12-30T00:30:00Z")
    rates = final_rate_on(published, days, tuesday_night)
    assert rates.tolist() == [1.25, 1.26, 1.26, 1.26, 1.26, 1.27, 1.28]
    # Without Christmas Eve's rate, the holiday after it takes 23 Dec's at once;
    # Christmas Eve itself waits three more business days, then takes it too.
    gap = published.drop(pd.Timestamp("2026-12-24"))
    pending = final_rate_on(gap, days, tuesday_night)
    assert pending.isna().tolist() == [False, True, False, False, False, False, False]
    assert pending[pd.Timestamp("2026-12-25")] == 1.25
    settled = final_rate_on(gap, days, pd.Timestamp("2026-12-31T00:30:00Z"))
    assert settled.tolist() == [1.25, 1.25, 1.25, 1.25, 1.25, 1.27, 1.28]


def test_a_rate_the_provider_never_publishes_settles_after_three_business_days() -> None:
    # The provider has no GBPUSD rate for Tuesday 11 Jul 2017, while New York
    # traded: the close waits three business days for it, then takes Monday's.
    sessions = pd.bdate_range("2017-06-01", "2017-07-14").drop(pd.Timestamp("2017-07-04"))
    quotes = pd.Series(125.0, index=sessions)
    rates = pd.Series(1.25, index=pd.bdate_range("2017-06-01", "2017-07-14"))
    rates = rates.drop(pd.Timestamp("2017-07-11"))
    rates[pd.Timestamp("2017-07-10")] = 1.30
    fills = [_usd_fill("2017-07-11T15:00:00Z", "Market buy", 60, 6_000)]

    def review(viewed: str) -> dict:
        found = _review_from_quotes(fills, {"NVDA": quotes}, viewed=viewed, rates=rates)
        return found["decisions"][0]

    for viewed in ("2017-07-11", "2017-07-12", "2017-07-13"):
        waiting = review(viewed)
        assert (waiting["observed_days"], waiting["effect_to_date_gbp"]) == (0, None)
    settled = review("2017-07-14")
    assert settled["observed_days"] == 3
    assert settled["effect_to_date_gbp"] == pytest.approx(240.0)


def test_a_session_without_a_close_settles_after_three_and_a_late_close_restates_it() -> None:
    # The provider has no NVDA bar for Tuesday 3 Nov, a regular New York session.
    # A £6,600 buy that day waits three sessions for it, then is measured from
    # Monday's close; when the provider fills 3 Nov in, the effect is restated.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-06"))  # dollars
    quotes[pd.Timestamp("2026-11-02")] = 100.0
    quotes[pd.Timestamp("2026-11-03")] = 110.0
    missing = quotes.drop(pd.Timestamp("2026-11-03"))
    fills = [_usd_fill("2026-11-03T15:00:00Z", "Market buy", 75, 6_600)]

    def review(listing: pd.Series, viewed: str) -> dict:
        return _review_from_quotes(fills, {"NVDA": listing}, viewed=viewed)["decisions"][0]

    for viewed in ("2026-11-04", "2026-11-05"):
        waiting = review(missing, viewed)
        assert (waiting["observed_days"], waiting["effect_to_date_gbp"]) == (0, None)
    settled = review(missing, "2026-11-06")
    assert settled["observed_days"] == 3
    assert settled["effect_to_date_gbp"] == pytest.approx(1_650.0)
    restated = review(quotes, "2026-11-06")
    assert restated["effect_to_date_gbp"] == pytest.approx(900.0)


def test_a_halted_listing_settles_on_its_last_close_instead_of_observing() -> None:
    # No bars after 1 Oct, for five weeks of New York sessions.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-09-01", "2026-10-01"))
    quotes[pd.Timestamp("2026-10-01")] = 150.0
    fills = [
        _usd_fill("2026-09-30T15:00:00Z", "Market buy", 10, 1_000),
        _usd_fill("2026-10-01T15:00:00Z", "Market sell", 10, 1_200),
    ]
    buy, sell = _review_from_quotes(fills, {"NVDA": quotes}, viewed="2026-11-04")["decisions"]
    # Only the last three sessions are still pending; the rest carry 1 Oct's close.
    assert (buy["observed_days"], buy["horizon_complete"]) == (22, True)
    assert buy["effect_horizon_gbp"] == buy["effect_to_date_gbp"] == pytest.approx(200.0)
    assert (sell["observed_days"], sell["horizon_complete"]) == (21, True)
    assert sell["effect_horizon_gbp"] == sell["effect_to_date_gbp"] == 0.0


def test_a_listing_without_a_known_exchange_waits_for_its_day_to_end() -> None:
    # The provider names no exchange for this listing, so no calendar says when
    # its session ends: 4 Nov's bar is a close once that UTC day is over.
    quotes = pd.Series(100.0, index=pd.bdate_range("2026-10-19", "2026-11-04"))  # pence
    fills = [_fill("2026-11-03T10:00:00Z", "Market buy", 1_000, 1_000, "ABC")]
    evening, next_day = (
        _review_from_quotes(fills, {"ABC.L": quotes}, viewed="2026-11-04", now=now)
        for now in ("2026-11-04T22:00:00Z", "2026-11-05T00:30:00Z")
    )
    assert evening["decisions"][0]["observed_days"] == 0
    assert next_day["decisions"][0]["observed_days"] == 1


def test_the_benchmark_runs_to_the_securitys_own_latest_close() -> None:
    # The listing last traded on 3 Nov; the benchmark's 4 Nov rise is not its window.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-03"))
    market = pd.Series(400.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))
    market[pd.Timestamp("2026-11-04")] = 420.0
    review = _review_from_quotes(
        [_usd_fill("2026-10-30T15:00:00Z", "Market buy", 10, 1_000)],
        {"NVDA": quotes},
        viewed="2026-11-04",
        market=market,
    )
    assert review["decisions"][0]["market_return_to_date"] == 0.0


def test_the_benchmark_waits_for_its_own_close_on_the_securitys_latest_day() -> None:
    # Hong Kong has closed on 4 Nov; New York has not, so the benchmark's latest
    # close is 3 Nov's and the window has no end on its side yet.
    days = pd.bdate_range("2026-10-26", "2026-11-04")
    trades = _trade_columns(
        pd.DataFrame([_fill("2026-10-28T03:00:00Z", "Market buy", 20, 1_000, "0700")])
    )
    identity = trades["SecurityIdentity"].iloc[0]
    prices = {
        identity: SecurityPrices(
            identity, "0700", "Tencent", "0700.HK", pd.Series(50.0, index=days)
        )
    }
    market = pd.Series(400.0, index=days[:-1])
    waiting = build_decision_review(trades, prices, as_of=days[-1], market=market)
    assert waiting["decisions"][0]["market_return_to_date"] is None
    market[days[-1]] = 420.0
    closed = build_decision_review(trades, prices, as_of=days[-1], market=market)
    assert closed["decisions"][0]["market_return_to_date"] == pytest.approx(0.05)


def test_a_benchmark_session_without_a_close_withholds_its_windows() -> None:
    # 3 Nov is a New York session the benchmark has no close for yet: a window
    # from 3 Nov has no benchmark change, rather than one measured from 2 Nov.
    quotes = pd.Series(125.0, index=pd.bdate_range("2026-10-01", "2026-11-04"))
    market = pd.Series(400.0, index=quotes.index)
    market[pd.Timestamp("2026-11-04")] = 420.0
    review = _review_from_quotes(
        [
            _usd_fill("2026-10-30T15:00:00Z", "Market buy", 10, 1_000),
            _usd_fill("2026-11-03T15:00:00Z", "Market buy", 10, 1_000),
        ],
        {"NVDA": quotes},
        viewed="2026-11-04",
        market=market.drop(pd.Timestamp("2026-11-03")),
    )
    earlier, on_the_gap = review["decisions"]
    assert earlier["market_return_to_date"] == pytest.approx(0.05)
    assert on_the_gap["market_return_to_date"] is None


def test_the_benchmark_carries_its_close_across_its_exchanges_holiday() -> None:
    # London trades on Thanksgiving and New York does not: a decision that day
    # starts from the benchmark's 25 Nov close.
    quotes = pd.Series(100.0, index=pd.bdate_range("2026-11-02", "2026-11-30"))  # pence
    market = pd.Series(400.0, index=quotes.index.drop(pd.Timestamp("2026-11-26")))
    market[market.index > pd.Timestamp("2026-11-26")] = 420.0
    review = _review_from_quotes(
        [_fill("2026-11-26T10:00:00Z", "Market buy", 1_000, 1_000, "VOD")],
        {"VOD.L": quotes},
        viewed="2026-11-30",
        market=market,
    )
    assert review["decisions"][0]["market_return_to_date"] == pytest.approx(0.05)


def test_a_benchmark_holiday_on_the_latest_close_takes_the_session_before() -> None:
    # On Friday 3 Jul 2026 London trades while New York observes Independence Day:
    # a window to 3 Jul ends on the benchmark's 2 Jul close, all weekend.
    quotes = pd.Series(100.0, index=pd.bdate_range("2026-06-15", "2026-07-03"))  # pence
    market = pd.Series(400.0, index=pd.bdate_range("2026-06-15", "2026-07-02"))
    market[pd.Timestamp("2026-07-02")] = 410.0
    review = _review_from_quotes(
        [_fill("2026-07-01T10:00:00Z", "Market buy", 1_000, 1_000, "VOD")],
        {"VOD.L": quotes},
        viewed="2026-07-05",
        market=market,
    )
    assert review["decisions"][0]["market_return_to_date"] == pytest.approx(0.025)


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


def _fetch_with_todays_bar(calls: list[date], exchange: str | None):
    """Provider rows through end, today's included while its session is still open."""

    def fetch(symbol: str, start: date, end: date) -> pd.DataFrame:
        calls.append(start)
        frame = pd.DataFrame(
            {"Close": 125.0, "Stock Splits": 0.0}, index=pd.bdate_range(start, end)
        )
        if exchange:
            frame.attrs["exchange"] = exchange
        return frame

    return fetch


def test_cache_holds_closed_sessions_only_and_fetches_a_bar_once_it_closes(tmp_path) -> None:
    calls: list[date] = []
    clock = {"now": datetime.fromisoformat("2026-11-04T15:10:00+00:00")}
    cache = CachedDailyHistory(
        tmp_path, fetch=_fetch_with_todays_bar(calls, "NMS"), now=lambda: clock["now"]
    )
    # A cache from before completed bars can hold a bar that was still forming.
    cache._path("NVDA").write_text(
        json.dumps(
            {
                "format": 2,
                "symbol": "NVDA",
                "start": "2026-10-01",
                "end": "2026-11-04",
                "fetched_at": "2026-11-04T15:00:00+00:00",
                "rows": [["2026-11-04", 137.5, 0.0, 0.0, None, None]],
            }
        )
    )
    window = (date(2026, 10, 1), date(2026, 11, 4))
    trading = cache("NVDA", *window)
    assert (len(calls), trading.index[-1], trading.attrs["exchange"]) == (
        1,
        pd.Timestamp("2026-11-03"),
        "NMS",
    )
    stored = json.loads(cache._path("NVDA").read_text())
    assert (stored["exchange"], stored["rows"][-1][0]) == ("NMS", "2026-11-03")
    clock["now"] = datetime.fromisoformat("2026-11-04T20:30:00+00:00")
    cache("NVDA", *window)
    assert len(calls) == 1  # still trading: nothing new to fetch
    # Less than six hours since the fetch, but New York closed at 21:00 UTC.
    clock["now"] = datetime.fromisoformat("2026-11-04T21:05:00+00:00")
    closed = cache("NVDA", *window)
    assert (len(calls), closed.index[-1]) == (2, pd.Timestamp("2026-11-04"))
    cache("NVDA", *window)
    assert len(calls) == 2


def test_cache_without_an_exchange_fetches_a_day_once_that_day_is_over(tmp_path) -> None:
    calls: list[date] = []
    clock = {"now": datetime.fromisoformat("2026-11-04T22:00:00+00:00")}
    cache = CachedDailyHistory(
        tmp_path, fetch=_fetch_with_todays_bar(calls, None), now=lambda: clock["now"]
    )
    window = (date(2026, 10, 1), date(2026, 11, 4))
    assert cache("ABC.L", *window).index[-1] == pd.Timestamp("2026-11-03")
    clock["now"] = datetime.fromisoformat("2026-11-04T23:30:00+00:00")
    cache("ABC.L", *window)
    assert len(calls) == 1
    clock["now"] = datetime.fromisoformat("2026-11-05T00:30:00+00:00")
    assert cache("ABC.L", *window).index[-1] == pd.Timestamp("2026-11-04")
    assert len(calls) == 2


def test_cache_asks_again_for_a_closed_session_whose_bar_was_late(tmp_path) -> None:
    fetched: list[datetime] = []
    published = {"through": date(2026, 11, 3)}  # 4 Nov's final bar is not out at 21:05
    clock = {"now": datetime.fromisoformat("2026-11-04T21:05:00+00:00")}

    def fetch(symbol: str, start: date, end: date) -> pd.DataFrame:
        fetched.append(clock["now"])
        index = pd.bdate_range(start, min(end, published["through"]))
        frame = pd.DataFrame({"Close": 125.0, "Stock Splits": 0.0}, index=index)
        frame.attrs["exchange"] = "NMS"
        return frame

    cache = CachedDailyHistory(tmp_path, fetch=fetch, now=lambda: clock["now"])
    window = (date(2026, 10, 1), date(2026, 11, 4))
    assert cache("NVDA", *window).index[-1] == pd.Timestamp("2026-11-03")
    published["through"] = date(2026, 11, 4)
    clock["now"] = datetime.fromisoformat("2026-11-04T23:00:00+00:00")
    cache("NVDA", *window)
    assert len(fetched) == 1  # inside the refresh interval
    clock["now"] = datetime.fromisoformat("2026-11-05T09:05:00+00:00")
    assert cache("NVDA", *window).index[-1] == pd.Timestamp("2026-11-04")
    assert len(fetched) == 2
    cache("NVDA", *window)
    assert len(fetched) == 2


def test_cache_reads_the_exchange_from_the_history_request_itself(tmp_path, monkeypatch) -> None:
    requests: list[str] = []

    class Provider:
        def __init__(self, symbol: str) -> None:
            self.symbol = symbol
            self._price_history = None

        def history(self, *, start: str, end: str, **_: object) -> pd.DataFrame:
            requests.append("history " + self.symbol)
            # yfinance keeps the chart response's metadata from this request.
            self._price_history = SimpleNamespace(_history_metadata={"exchangeName": "NMS"})
            last = pd.Timestamp(end) - pd.Timedelta(days=1)
            index = pd.bdate_range(start, last, tz="America/New_York")
            return pd.DataFrame({"Close": 125.0, "Stock Splits": 0.0}, index=index)

        def get_history_metadata(self) -> dict:
            requests.append("metadata " + self.symbol)  # five days of hourly bars
            return {"exchangeName": "NMS"}

    monkeypatch.setattr(decision_prices.yf, "Ticker", Provider)
    clock = {"now": datetime.fromisoformat("2026-11-04T22:00:00+00:00")}
    window = (date(2026, 10, 1), date(2026, 11, 4))
    cold = CachedDailyHistory(tmp_path, now=lambda: clock["now"])
    assert [cold(symbol, *window).attrs["exchange"] for symbol in ("NVDA", "AMD")] == ["NMS"] * 2
    # A cold cache makes one request per listing, none of them for metadata.
    assert requests == ["history NVDA", "history AMD"]
    # A warm cache in a new process asks for nothing more.
    warm = CachedDailyHistory(tmp_path, now=lambda: clock["now"])
    assert [warm(symbol, *window).attrs["exchange"] for symbol in ("NVDA", "AMD")] == ["NMS"] * 2
    assert len(requests) == 2
    # The next close is one history request again.
    clock["now"] = datetime.fromisoformat("2026-11-05T21:30:00+00:00")
    warm("NVDA", date(2026, 10, 1), date(2026, 11, 5))
    assert requests[2:] == ["history NVDA"]


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
