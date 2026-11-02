from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from trading_max.analytics.day_attribution import (
    trading_day,
    update_day_attribution,
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
