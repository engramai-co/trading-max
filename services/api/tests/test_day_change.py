from __future__ import annotations

import pytest

from services.api.trading_max_api.projections.day_change import holding_day_changes

OBSERVED = {"fetched_at": "2026-11-04T15:50:00Z"}


def _row(ticker: str, amount: str, opening: str | None = None) -> dict[str, object]:
    row: dict[str, object] = {"ticker": ticker, "name": ticker, "contribution_gbp": amount}
    if opening is not None:
        row["opening_value_gbp"] = opening
    return row


def _attribution(*rows: dict[str, object], as_of: str = "2026-11-04T15:50:00Z"):
    return {
        "day": "2026-11-04",
        "accounts": {
            "A": {"since": "2026-11-04T00:00:00Z", "as_of": as_of, "contributions": list(rows)}
        },
    }


def test_day_change_is_the_contribution_and_its_share_of_the_opening_value():
    changes = holding_day_changes(_attribution(_row("NVDA", "-74.00", "1500.00")), {"A": OBSERVED})
    amount, share = changes[("A", "NVDA")]
    assert amount == -74.0
    assert share == pytest.approx(-74 / 1500)


def test_the_same_observation_matches_across_timestamp_spellings():
    account = {"fetched_at_utc": "2026-11-04T15:50:00+00:00"}
    changes = holding_day_changes(_attribution(_row("NVDA", "1.00", "10.00")), {"A": account})
    assert changes[("A", "NVDA")][0] == 1.0


@pytest.mark.parametrize(
    ("attribution", "accounts"),
    [
        (None, {"A": OBSERVED}),
        ({"day": "2026-11-04"}, {"A": OBSERVED}),
        (_attribution(_row("NVDA", "1.00", "10.00")), {"B": OBSERVED}),
        # Measured ten minutes before the holdings: never pair it with newer values.
        (
            _attribution(_row("NVDA", "1.00", "10.00"), as_of="2026-11-04T15:40:00Z"),
            {"A": OBSERVED},
        ),
        (_attribution(_row("NVDA", "1.00", "10.00")), {"A": {}}),
    ],
)
def test_missing_stale_or_unmatched_attribution_gives_no_day_change(attribution, accounts):
    assert holding_day_changes(attribution, accounts) == {}


def test_an_attribution_without_opening_values_gives_pounds_only():
    changes = holding_day_changes(_attribution(_row("NVDA", "12.34")), {"A": OBSERVED})
    assert changes == {("A", "NVDA"): (12.34, None)}


def test_rows_sharing_a_ticker_are_combined_and_a_zero_opening_has_no_share():
    changes = holding_day_changes(
        _attribution(
            _row("BRK", "3.00", "100.00"),
            _row("BRK", "1.00", "60.00"),
            _row("NEW", "0.00", "0.00"),
        ),
        {"A": OBSERVED},
    )
    assert changes[("A", "BRK")][0] == 4.0
    assert changes[("A", "BRK")][1] == pytest.approx(4 / 160)
    assert changes[("A", "NEW")] == (0.0, None)
