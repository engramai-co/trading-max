from __future__ import annotations

from collections.abc import Sequence

import pandas as pd
import pytest
from trading_max.analytics.historical_nav import LedgerEvent
from trading_max.analytics.review_evidence import ReviewListing, build_review_evidence
from trading_max.research.calendar import market_calendar

A = "isin:GB000000SYN1"
B = "isin:US000000SYN2"


def event(
    when: str, cash: float, identity: str | None = None, qty: float = 0, side=None, currency="GBP"
) -> LedgerEvent:
    return LedgerEvent(
        pd.Timestamp(when, tz="UTC"),
        identity,
        qty,
        currency,
        cash,
        identity is None,
        side,
        "SYN" if identity == A else "USYN" if identity == B else None,
    )


def listing(*, usd: bool = False, changes=None, split=None, missing=None) -> ReviewListing:
    exchange, currency = ("NYQ", "USD") if usd else ("LSE", "GBP")
    cal = market_calendar("XNYS" if usd else "XLON", 2026, 2026)
    days = cal.sessions[(cal.sessions >= "2026-03-01") & (cal.sessions <= "2026-07-31")]
    closes = pd.Series(100.0, index=days)
    for day, price in (changes or {}).items():
        closes.loc[day:] = price
    frame = pd.DataFrame({"Close": closes, "Stock Splits": 0.0})
    if split:
        day, factor = split
        frame.loc[day, "Stock Splits"] = factor
    if missing:
        frame = frame.drop(pd.Timestamp(missing))
    frame.attrs["exchange"] = exchange
    return ReviewListing(
        "USYN" if usd else "SYN", currency, "USYN" if usd else "SYN.L", currency, frame
    )


def compute(
    events: Sequence[LedgerEvent],
    *,
    markets,
    rates=None,
    end="2026-04-30 23:59:59",
    terminal_holdings,
    terminal_cash,
):
    return build_review_evidence(
        events,
        markets,
        rates or {},
        as_of=pd.Timestamp(end, tz="UTC"),
        terminal_holdings=terminal_holdings,
        terminal_cash_gbp=terminal_cash,
        terminal_value_gbp=1000,
    )


def test_move_uses_actual_consecutive_exchange_closes_and_checks_all_trades_that_day():
    events = [
        event("2026-04-01 08:00", 2000),
        event("2026-04-01 09:00", -1000, A, 10, "buy"),
        # Both fills net to zero, but this close-to-close move is still traded.
        event("2026-04-08 10:30", -40, A, 0.4, "buy"),
        event("2026-04-08 11:00", 40, A, -0.4, "sell"),
    ]
    result = compute(
        events,
        markets={A: listing(changes={"2026-04-07": 105, "2026-04-08": 119, "2026-04-09": 110})},
        terminal_holdings={A: 10},
        terminal_cash=1000,
    )
    assert result.coverage == "complete"
    # Good Friday and Easter Monday were not London sessions.
    assert [(str(x.date), x.change) for x in reversed(result.holding_moves)] == [
        ("2026-04-07", pytest.approx(0.05)),
        ("2026-04-09", pytest.approx(110 / 119 - 1)),
    ]


def test_cash_spans_count_london_sessions_and_report_peak_and_average():
    events = [event("2026-03-30 07:00", 1000), event("2026-03-30 09:00", -900, A, 9, "buy")]
    result = compute(
        events,
        markets={A: listing(changes={"2026-04-07": 90, "2026-04-15": 120})},
        terminal_holdings={A: 9},
        terminal_cash=100,
    )
    [span] = result.cash_spans
    # 30 Mar–14 Apr inclusive: ten sessions, excluding weekends and two holidays.
    assert (str(span.start), str(span.end), span.sessions) == ("2026-03-30", "2026-04-14", 10)
    assert span.peak_share == pytest.approx(100 / 910)
    assert span.average_share == pytest.approx((4 * 0.10 + 6 * (100 / 910)) / 10)


def test_drift_requires_no_fill_at_either_endpoint_or_inside_the_window():
    events = [
        event("2026-04-01 07:00", 2000),
        event("2026-04-01 09:00", -1000, A, 10, "buy"),
        event("2026-04-08 12:00", -130, A, 1, "buy"),
        event("2026-04-08 14:00", 130, A, -1, "sell"),
    ]
    result = compute(
        events,
        markets={A: listing(changes={"2026-04-08": 130, "2026-04-15": 160})},
        terminal_holdings={A: 10},
        terminal_cash=1000,
    )
    [drift] = result.weight_drifts
    assert drift.before == pytest.approx(1300 / 2300)
    assert drift.after == pytest.approx(1600 / 2600)
    assert drift.start.isoformat() >= "2026-04-09"
    assert (drift.end - drift.start).days <= 30


def test_drift_never_uses_endpoints_more_than_thirty_calendar_days_apart():
    events = [
        event("2026-04-01 07:00", 2000),
        event("2026-04-01 09:00", -1000, A, 10, "buy"),
    ]
    result = compute(
        events,
        markets={A: listing(changes={"2026-04-08": 108, "2026-05-18": 117})},
        terminal_holdings={A: 10},
        terminal_cash=1000,
        end="2026-06-01 14:00",
    )
    # Each step moves less than 3pp, but the two together would exceed it.
    assert not result.weight_drifts


def test_each_partial_fill_uses_same_prices_and_fx_without_using_future_bars():
    events = [
        event("2026-04-07 07:00", 1000),
        event("2026-04-07 09:00", -100, A, 1, "buy"),
        event("2026-04-09 14:00", -60, B, 1, "buy"),
        event("2026-04-09 14:01", -30, B, 0.5, "buy"),
        event("2026-04-09 14:02", 25, B, -0.5, "sell"),
    ]
    rates = pd.DataFrame({"Close": 2.0}, index=pd.bdate_range("2026-04-01", "2026-05-01"))
    rates.loc["2026-04-09", "Close"] = 4.0
    result = compute(
        events,
        markets={
            A: listing(),
            B: listing(usd=True, changes={"2026-04-09": 200}),
        },
        rates={"USD": rates},
        terminal_holdings={A: 1, B: 1},
        terminal_cash=835,
    )
    sold, second, first, _ = result.fill_effects
    assert (first.side, second.side, sold.side) == ("buy", "buy", "sell")
    assert [first.quantity, second.quantity, sold.quantity] == [1, 0.5, 0.5]
    assert first.before.cash == pytest.approx(0.9)
    assert first.after.cash == pytest.approx(840 / 990)
    assert first.after.largest_holding == pytest.approx(100 / 990)
    assert first.after.usd_exposure == pytest.approx(50 / 990)
    assert second.before == first.after
    assert sold.before == second.after
    assert sold.after.usd_exposure == pytest.approx(50 / 985)


def test_missing_fx_or_quote_omits_affected_rows_but_keeps_independent_local_moves():
    events = [
        event("2026-04-07 07:00", 1000),
        event("2026-04-07 14:00", -100, B, 1, "buy"),
        event("2026-04-09 14:00", -30, B, 0.5, "buy"),
    ]
    result = compute(
        events,
        markets={
            B: listing(
                usd=True, changes={"2026-04-08": 106, "2026-04-15": 130}, missing="2026-04-14"
            )
        },
        terminal_holdings={B: 1.5},
        terminal_cash=870,
    )
    assert result.coverage == "partial"
    assert not result.fill_effects and not result.cash_spans and not result.weight_drifts
    assert [str(row.date) for row in result.holding_moves] == ["2026-04-08"]


def test_splits_keep_close_returns_and_intraday_weights_on_the_correct_share_basis():
    events = [
        event("2026-04-01 07:00", 1000),
        event("2026-04-01 09:00", -200, A, 1, "buy"),
        event("2026-04-09 07:00", 0, A, -1),
        event("2026-04-09 07:00", 0, A, 2),
        event("2026-04-09 10:00", -50, A, 0.5, "buy"),
    ]
    result = compute(
        events,
        markets={A: listing(split=("2026-04-09", 2))},
        terminal_holdings={A: 2.5},
        terminal_cash=750,
    )
    assert not result.holding_moves
    assert not result.weight_drifts
    latest, opening = result.fill_effects
    assert opening.after.largest_holding == pytest.approx(0.20)
    assert latest.before.largest_holding == pytest.approx(0.20)
    assert latest.after.largest_holding == pytest.approx(0.25)


def test_tied_fills_and_unreconciled_ledgers_do_not_create_before_after_rows():
    events = [
        event("2026-04-01 07:00", 1000),
        event("2026-04-01 09:00", -100, A, 1, "buy"),
        event("2026-04-01 09:00", -50, A, 0.5, "buy"),
    ]
    valid = compute(events, markets={A: listing()}, terminal_holdings={A: 1.5}, terminal_cash=850)
    assert valid.coverage == "partial"
    assert not valid.fill_effects
    assert valid.cash_spans
    invalid = compute(events, markets={A: listing()}, terminal_holdings={A: 3}, terminal_cash=850)
    assert invalid.coverage == "partial"
    assert not invalid.cash_spans and not invalid.fill_effects


def test_sterling_listing_resolves_when_no_dollar_rates_are_available():
    from trading_max.analytics.decision_prices import resolve_decision_prices

    trades = pd.DataFrame(
        {
            "TradePrice": [100.0],
            "Action": ["Market buy"],
            "SecurityIdentity": [A],
            "Ticker": ["SYN"],
            "TradeCurrency": ["GBP"],
            "TotalCurrency": ["GBP"],
            "Shares": [1.0],
            "TotalN": [100.0],
            "BusinessDate": [pd.Timestamp("2026-04-01")],
        }
    )

    def loader(symbol, _start, _end):
        if symbol == "GBPUSD=X":
            return pd.DataFrame(columns=["Close"])
        return listing().frame

    prices, missing = resolve_decision_prices(
        trades,
        end_day=pd.Timestamp("2026-04-30"),
        now=pd.Timestamp("2026-05-01", tz="UTC"),
        history_loader=loader,
        allow_missing_usd=True,
    )
    assert not missing
    assert prices[A].listing_currency == "GBP"


def test_move_uses_own_prior_sixty_returns_and_excludes_the_session_being_tested():
    from statistics import stdev

    events = [
        event("2026-04-07 07:00", 3000),
        event("2026-04-07 09:00", -100, A, 1, "buy"),
        event("2026-04-07 09:01", -100, B, 1, "buy"),
    ]
    calm, volatile = listing(), listing()
    # Two distinct listings can share one exchange calendar.
    volatile = ReviewListing("VOL", "GBP", "VOL.L", "GBP", volatile.frame)
    target = pd.Timestamp("2026-07-08")
    prior_days = calm.frame.index[calm.frame.index < target]
    assert len(prior_days) > 61
    for market, amplitude in [(calm, 0.002), (volatile, 0.05)]:
        # Very early observations are deliberately volatile. They cannot
        # contribute to the threshold, even if present in the provider frame.
        price = 100.0
        for i, day in enumerate(prior_days):
            step = amplitude if day in prior_days[-60:] else 0.25
            price *= 1 + step * (-1 if i % 2 else 1)
            market.frame.loc[day, "Close"] = price
        market.frame.loc[target:, "Close"] = price * 1.08
    result = compute(
        events,
        markets={A: calm, B: volatile},
        end="2026-07-08 21:00",
        terminal_holdings={A: 1, B: 1},
        terminal_cash=2800,
    )
    [move] = [row for row in result.holding_moves if row.date == target.date()]
    assert move.ticker == "SYN"
    assert move.basis == "volatility"
    assert move.prior_returns == 60
    assert move.threshold == 0.05
    assert 2.5 * stdev([0.05, -0.05] * 30) > move.change


def test_short_history_falls_back_until_twenty_usable_returns_including_gaps():
    market = listing()
    market.frame.drop(market.frame.index[market.frame.index < "2026-04-01"], inplace=True)
    market.frame.drop(pd.Timestamp("2026-04-10"), inplace=True)
    target = pd.Timestamp("2026-05-01")
    market.frame.loc[target:, "Close"] = 105.0
    events = [event("2026-04-01 07:00", 2000), event("2026-04-01 09:00", -100, A, 1, "buy")]
    result = compute(
        events,
        markets={A: market},
        end="2026-05-01 21:00",
        terminal_holdings={A: 1},
        terminal_cash=1900,
    )
    [move] = result.holding_moves
    assert move.basis == "short_history"
    # Good Friday, Easter Monday and weekends are absent; a missing close
    # removes the return on that day and on the following trading session.
    assert move.prior_returns == 17
    assert move.threshold == 0.05


def test_only_three_most_recent_qualifying_sessions_per_holding_are_kept():
    changes = {
        "2026-06-01": 110,
        "2026-06-03": 121,
        "2026-06-08": 133.1,
        "2026-06-15": 146.41,
        "2026-06-22": 161.051,
    }
    events = [
        event("2026-04-01 07:00", 2000),
        event("2026-04-01 09:00", -100, A, 1, "buy"),
        event("2026-04-01 09:01", -100, B, 1, "buy"),
    ]
    second = listing(changes=changes)
    result = compute(
        events,
        markets={
            A: listing(changes=changes),
            B: ReviewListing("SYN2", "GBP", "SYN2.L", "GBP", second.frame),
        },
        end="2026-06-30 21:00",
        terminal_holdings={A: 1, B: 1},
        terminal_cash=1800,
    )
    for ticker in ("SYN", "SYN2"):
        assert [str(row.date) for row in result.holding_moves if row.ticker == ticker] == [
            "2026-06-22",
            "2026-06-15",
            "2026-06-08",
        ]


def test_session_being_tested_cannot_raise_its_own_threshold():
    market = listing()
    days = market.frame.index
    first = days.get_loc(pd.Timestamp("2026-05-01"))
    prior = days[first : first + 20]
    target = days[first + 20]
    market.frame.drop(days[: first - 1], inplace=True)
    price = 100
    for i, day in enumerate(prior):
        price *= 1 + (0.023 if i % 2 else -0.023)
        market.frame.loc[day, "Close"] = price
    market.frame.loc[target:, "Close"] = price * 1.06
    events = [event("2026-05-01 07:00", 2000), event("2026-05-01 09:00", -100, A, 1, "buy")]
    result = compute(
        events,
        markets={A: market},
        end=f"{target.date()} 21:00",
        terminal_holdings={A: 1},
        terminal_cash=1900,
    )
    # 6% exceeds 2.5× the prior sample volatility (~5.9%), but adding
    # today's 6% to the sample would push the threshold above 6%.
    [move] = result.holding_moves
    assert move.prior_returns == 20
    assert move.basis == "volatility"
    assert 0.05 < move.threshold < 0.06
