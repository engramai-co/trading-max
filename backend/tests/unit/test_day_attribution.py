from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from trading_max.analytics.day_attribution import (
    baseline_from_accounts,
    trading_day,
    update_day_attribution,
    update_window_attribution,
    window_days,
)


def _account(fetched_at: str, *positions: tuple[str, str, str]):
    return {
        "fetched_at": fetched_at,
        "positions": [
            {
                "ticker": ticker,
                "broker_ticker": ticker + "_US_EQ",
                "name": ticker + " Inc",
                "quantity": quantity,
                "current_value_gbp": value,
            }
            for ticker, quantity, value in positions
        ],
    }


def _contributions(attribution, code="A"):
    return {row.ticker: row.contribution_gbp for row in attribution.accounts[code].contributions}


def test_first_observation_opens_the_day_with_zero_contributions():
    baseline, attribution = update_day_attribution(
        None, {"A": _account("2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"))}
    )
    assert baseline.day.isoformat() == "2026-11-02"
    assert _contributions(attribution) == {"NVDA": Decimal("0.00")}
    assert attribution.accounts["A"].since == baseline.accounts["A"].captured_at


def test_later_observation_attributes_price_change_of_shares_held_all_day():
    opening, _ = update_day_attribution(
        None,
        {"A": _account("2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"), ("AAPL", "4", "800.00"))},
    )
    _, attribution = update_day_attribution(
        opening.model_dump(mode="json", by_alias=False),
        {"A": _account("2026-11-02T15:40:00Z", ("NVDA", "10", "1426.00"), ("AAPL", "4", "812.00"))},
    )
    assert _contributions(attribution) == {"NVDA": Decimal("-74.00"), "AAPL": Decimal("12.00")}
    # Largest absolute contribution first.
    assert [row.ticker for row in attribution.accounts["A"].contributions] == ["NVDA", "AAPL"]


def test_shares_traded_during_the_day_stay_out_of_the_position_contribution():
    opening, _ = update_day_attribution(
        None,
        {
            "A": _account(
                "2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"), ("SOFI", "50", "500.00")
            )
        },
    )
    # Bought 5 more NVDA (value per share 150 -> 140) and sold all SOFI.
    _, attribution = update_day_attribution(
        opening.model_dump(mode="json", by_alias=False),
        {"A": _account("2026-11-02T15:40:00Z", ("NVDA", "15", "2100.00"))},
    )
    # Only the 10 shares held since the open count: 10 x (140 - 150).
    assert _contributions(attribution) == {"NVDA": Decimal("-100.00")}


def test_contribution_carries_the_opening_value_of_the_shares_it_covers():
    opening, first = update_day_attribution(
        None,
        {
            "A": _account(
                "2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"), ("SOFI", "50", "500.00")
            )
        },
    )
    assert {row.ticker: row.opening_value_gbp for row in first.accounts["A"].contributions} == {
        "NVDA": Decimal("1500.00"),
        "SOFI": Decimal("500.00"),
    }
    # Bought 5 more NVDA and sold 20 SOFI: only the shares held all day count,
    # valued at the opening price, so the change reads as that price move.
    _, attribution = update_day_attribution(
        opening.model_dump(mode="json", by_alias=False),
        {
            "A": _account(
                "2026-11-02T15:40:00Z", ("NVDA", "15", "2100.00"), ("SOFI", "30", "330.00")
            )
        },
    )
    rows = {row.ticker: row for row in attribution.accounts["A"].contributions}
    assert (rows["NVDA"].contribution_gbp, rows["NVDA"].opening_value_gbp) == (
        Decimal("-100.00"),
        Decimal("1500.00"),
    )
    assert (rows["SOFI"].contribution_gbp, rows["SOFI"].opening_value_gbp) == (
        Decimal("30.00"),
        Decimal("300.00"),
    )


def test_new_trading_day_resets_the_baseline():
    opening, _ = update_day_attribution(
        None, {"A": _account("2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"))}
    )
    baseline, attribution = update_day_attribution(
        opening.model_dump(mode="json", by_alias=False),
        {"A": _account("2026-11-03T00:10:00Z", ("NVDA", "10", "1426.00"))},
    )
    assert baseline.day.isoformat() == "2026-11-03"
    assert _contributions(attribution) == {"NVDA": Decimal("0.00")}


def test_weekend_keeps_fridays_baseline_like_the_1d_chart():
    assert trading_day(datetime(2026, 11, 8, 12, tzinfo=UTC)).isoformat() == "2026-11-06"
    opening, _ = update_day_attribution(
        None, {"A": _account("2026-11-06T07:10:00Z", ("NVDA", "10", "1500.00"))}
    )
    baseline, attribution = update_day_attribution(
        opening.model_dump(mode="json", by_alias=False),
        {"A": _account("2026-11-07T10:00:00Z", ("NVDA", "10", "1460.00"))},
    )
    assert baseline.day.isoformat() == "2026-11-06"
    assert _contributions(attribution) == {"NVDA": Decimal("-40.00")}


def test_london_midnight_decides_the_day_in_summer_time():
    # 23:30 UTC on 1 September is 00:30 on 2 September in London.
    _, attribution = update_day_attribution(
        None, {"A": _account("2026-09-01T23:30:00Z", ("NVDA", "1", "150.00"))}
    )
    assert attribution.day.isoformat() == "2026-09-02"


def test_unreconciled_positions_neither_open_nor_attribute_an_account():
    unreconciled = {"fetched_at": "2026-11-02T07:10:00Z"}
    baseline, attribution = update_day_attribution(
        None,
        {"A": unreconciled, "B": _account("2026-11-02T07:10:00Z", ("EQGB", "9", "5300.00"))},
    )
    assert "A" not in attribution.accounts and "A" not in baseline.accounts
    # A later reconciled observation opens account A at its own time.
    baseline, attribution = update_day_attribution(
        baseline.model_dump(mode="json", by_alias=False),
        {
            "A": _account("2026-11-02T09:00:00Z", ("NVDA", "10", "1500.00")),
            "B": _account("2026-11-02T09:00:00Z", ("EQGB", "9", "5336.00")),
        },
    )
    assert attribution.accounts["A"].since.isoformat().startswith("2026-11-02T09:00")
    assert _contributions(attribution, "B") == {"EQGB": Decimal("36.00")}


def _window(previous, current, *, history=None):
    """Open or carry the day, then chain the 5D window up to the current observation."""

    baseline, _ = update_day_attribution(previous and previous["day"], current)
    window_baselines, window = update_window_attribution(
        previous and previous["window"], baseline, current, history=history
    )
    state = {
        "day": baseline.model_dump(mode="json", by_alias=False),
        "window": window_baselines.model_dump(mode="json", by_alias=False),
    }
    return state, window


def _two_listings(fetched_at: str, us_value: str, london_value: str):
    """One company held through two broker listings that share the display ticker IAG."""

    return {
        "fetched_at": fetched_at,
        "positions": [
            {
                "ticker": "IAG",
                "broker_ticker": "IAG_US_EQ",
                "name": "IAG (US)",
                "quantity": "10",
                "current_value_gbp": us_value,
            },
            {
                "ticker": "IAG",
                "broker_ticker": "IAGl_EQ",
                "name": "IAG (London)",
                "quantity": "100",
                "current_value_gbp": london_value,
            },
        ],
    }


def test_listings_sharing_a_ticker_keep_their_own_instrument():
    state, _ = _window(None, {"A": _two_listings("2026-11-02T07:10:00Z", "40.00", "300.00")})
    later = {"A": _two_listings("2026-11-02T15:40:00Z", "42.00", "290.00")}
    _, day = update_day_attribution(state["day"], later)
    rows = {row.instrument: row for row in day.accounts["A"].contributions}
    assert {
        key: (row.ticker, row.contribution_gbp, row.opening_value_gbp) for key, row in rows.items()
    } == {
        "IAG_US_EQ": ("IAG", Decimal("2.00"), Decimal("40.00")),
        "IAGl_EQ": ("IAG", Decimal("-10.00"), Decimal("300.00")),
    }
    _, window = _window(state, later)
    assert {row.instrument: row.contribution_gbp for row in window.accounts["A"].contributions} == {
        "IAG_US_EQ": Decimal("2.00"),
        "IAGl_EQ": Decimal("-10.00"),
    }


def test_window_days_are_the_five_weekdays_ending_on_the_trading_day():
    days = [
        day.isoformat() for day in window_days(trading_day(datetime(2026, 11, 3, 12, tzinfo=UTC)))
    ]
    assert days == ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"]


def test_window_chains_daily_openings_across_days():
    state, _ = _window(None, {"A": _account("2026-11-02T07:10:00Z", ("NVDA", "10", "1500.00"))})
    # Bought 10 more NVDA on Monday; Tuesday opens with 20 shares at 145.
    state, _ = _window(state, {"A": _account("2026-11-03T00:10:00Z", ("NVDA", "20", "2900.00"))})
    state, window = _window(
        state, {"A": _account("2026-11-03T15:00:00Z", ("NVDA", "20", "3000.00"))}
    )
    # Monday segment: 10 shares x (145 - 150) = -50; Tuesday: 20 x (150 - 145) = +100.
    assert _contributions(window) == {"NVDA": Decimal("50.00")}
    # A chained total has no single opening to compare it with.
    assert window.accounts["A"].contributions[0].opening_value_gbp is None
    assert window.start_day.isoformat() == "2026-10-28"
    assert window.accounts["A"].since.isoformat().startswith("2026-11-02T07:10")


def test_window_drops_openings_older_than_five_trading_days():
    state, _ = _window(None, {"A": _account("2026-10-27T07:10:00Z", ("NVDA", "10", "1000.00"))})
    state, window = _window(
        state, {"A": _account("2026-11-03T07:10:00Z", ("NVDA", "10", "1500.00"))}
    )
    # 27 October is outside 28 October to 3 November; only today's opening remains.
    assert [day["day"] for day in state["window"]["days"]] == ["2026-11-03"]
    assert _contributions(window) == {"NVDA": Decimal("0.00")}


def test_window_backfills_missing_openings_from_history():
    earlier = {
        "2026-10-28": _account("2026-10-28T00:10:00Z", ("NVDA", "10", "1400.00")),
        "2026-10-30": _account("2026-10-30T00:10:00Z", ("NVDA", "10", "1450.00")),
    }

    def history(day):
        account = earlier.get(day.isoformat())
        return baseline_from_accounts(day, {"A": account}) if account else None

    _, window = _window(
        None,
        {"A": _account("2026-11-03T15:00:00Z", ("NVDA", "10", "1500.00"))},
        history=history,
    )
    # 28 Oct -> 30 Oct -> 3 Nov opening -> now: 10 x (150 - 140) in total.
    assert _contributions(window) == {"NVDA": Decimal("100.00")}
    assert window.accounts["A"].since.isoformat().startswith("2026-10-28T00:10")
