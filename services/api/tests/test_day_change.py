from __future__ import annotations

import pytest

from services.api.trading_max_api.projections.day_change import (
    DayChange,
    holding_day_changes,
    within_trading_days,
)

OBSERVED = "2026-11-04T15:50:00Z"


def _row(
    ticker: str, amount: str, opening: str | None = None, instrument: str | None = None
) -> dict[str, object]:
    row: dict[str, object] = {"ticker": ticker, "name": ticker, "contribution_gbp": amount}
    if opening is not None:
        row["opening_value_gbp"] = opening
    if instrument is not None:
        row["instrument"] = instrument
    return row


def _attribution(
    *rows: dict[str, object],
    as_of: str = OBSERVED,
    day: str = "2026-11-04",
    since: str = "2026-11-04T00:00:00Z",
):
    return {
        "day": day,
        "accounts": {"A": {"since": since, "as_of": as_of, "contributions": list(rows)}},
    }


def _position(ticker: str, broker: str | None = None) -> dict[str, object]:
    return {"ticker": ticker, **({"broker_ticker": broker} if broker else {})}


def _account(*positions: dict[str, object], fetched_at: str = OBSERVED) -> dict[str, object]:
    return {"fetched_at": fetched_at, "positions": list(positions)}


def test_listings_sharing_a_ticker_join_on_their_own_instrument():
    changes = holding_day_changes(
        _attribution(
            _row("IAG", "2.00", "40.00", "IAG_US_EQ"),
            _row("IAG", "-10.00", "300.00", "IAGl_EQ"),
        ),
        {"A": _account(_position("IAG", "IAGl_EQ"), _position("IAG", "IAG_US_EQ"))},
    )
    london, us = changes["A"]
    assert london is not None and us is not None
    assert (london.gbp, london.date) == (-10.0, "2026-11-04")
    assert london.share == pytest.approx(-10 / 300)
    assert us.gbp == 2.0
    assert us.share == pytest.approx(2 / 40)


def test_legacy_rows_without_an_instrument_join_only_an_unambiguous_ticker():
    changes = holding_day_changes(
        _attribution(
            _row("NVDA", "-74.00", "1500.00"),
            _row("IAG", "2.00", "40.00"),
            _row("IAG", "-10.00", "300.00"),
        ),
        {
            "A": _account(
                _position("NVDA", "NVDA_US_EQ"),
                _position("IAG", "IAG_US_EQ"),
                _position("IAG", "IAGl_EQ"),
            )
        },
    )
    nvda, us, london = changes["A"]
    assert nvda is not None
    assert nvda.gbp == -74.0
    assert nvda.share == pytest.approx(-74 / 1500)
    assert us is None and london is None


def test_one_legacy_row_never_lands_on_two_holdings_that_share_its_ticker():
    changes = holding_day_changes(
        _attribution(_row("IAG", "2.00", "40.00")),
        {"A": _account(_position("IAG", "IAG_US_EQ"), _position("IAG", "IAGl_EQ"))},
    )
    assert changes["A"] == [None, None]


def test_a_holding_without_a_broker_listing_joins_an_unambiguous_ticker():
    changes = holding_day_changes(
        _attribution(_row("BE", "40.00", "960.00", "BE_US_EQ")),
        {"A": _account(_position("BE"))},
    )
    assert changes["A"] == [DayChange(40.0, pytest.approx(40 / 960), "2026-11-04")]


def test_a_different_known_listing_is_never_joined_by_ticker():
    changes = holding_day_changes(
        _attribution(_row("IAG", "2.00", "40.00", "IAG_US_EQ")),
        {"A": _account(_position("IAG", "IAGl_EQ"))},
    )
    assert changes["A"] == [None]


@pytest.mark.parametrize(
    ("attribution", "accounts"),
    [
        (None, {"A": _account(_position("NVDA"))}),
        ({"day": "2026-11-04"}, {"A": _account(_position("NVDA"))}),
        (_attribution(_row("NVDA", "1.00", "10.00")), {"B": _account(_position("NVDA"))}),
        # Measured ten minutes before the holdings: never pair it with newer values.
        (
            _attribution(_row("NVDA", "1.00", "10.00"), as_of="2026-11-04T15:40:00Z"),
            {"A": _account(_position("NVDA"))},
        ),
        # The account still shows Friday while the attribution covers Monday.
        (
            _attribution(
                _row("NVDA", "0.00", "10.00"), as_of="2026-11-06T20:00:00Z", day="2026-11-09"
            ),
            {"A": _account(_position("NVDA"), fetched_at="2026-11-06T20:00:00Z")},
        ),
        # Opened at Friday's observation and measured at Monday's first: the move
        # between them is not Monday's change.
        (
            _attribution(
                _row("NVDA", "10.00", "100.00"),
                since="2026-11-06T16:00:00Z",
                as_of="2026-11-09T08:10:00Z",
                day="2026-11-09",
            ),
            {"A": _account(_position("NVDA"), fetched_at="2026-11-09T08:10:00Z")},
        ),
        # An opening after the observation it was measured at.
        (
            _attribution(_row("NVDA", "1.00", "10.00"), since="2026-11-04T16:00:00Z"),
            {"A": _account(_position("NVDA"))},
        ),
        (_attribution(_row("NVDA", "1.00", "10.00")), {"A": {"positions": [_position("NVDA")]}}),
    ],
)
def test_missing_stale_or_unmatched_attribution_gives_no_day_change(attribution, accounts):
    assert holding_day_changes(attribution, accounts) == {}


def test_a_weekend_observation_keeps_fridays_opening_and_day():
    changes = holding_day_changes(
        _attribution(
            _row("NVDA", "4.00", "100.00"),
            since="2026-11-06T08:00:00Z",
            as_of="2026-11-07T10:00:00Z",
            day="2026-11-06",
        ),
        {"A": _account(_position("NVDA"), fetched_at="2026-11-07T10:00:00Z")},
    )
    assert changes["A"] == [DayChange(4.0, pytest.approx(0.04), "2026-11-06")]


def test_attributions_keep_only_accounts_measured_within_their_own_trading_days():
    def entry(since: str, as_of: str) -> dict[str, object]:
        return {"since": since, "as_of": as_of, "contributions": []}

    # Written before openings were kept per account: A opened at Friday's
    # observation under Monday, while B opened on Monday.
    day = {
        "schema_version": 1,
        "day": "2026-11-09",
        "accounts": {
            "A": entry("2026-11-06T16:00:00Z", "2026-11-09T08:10:00Z"),
            "B": entry("2026-11-09T08:00:00Z", "2026-11-09T08:10:00Z"),
        },
    }
    assert within_trading_days(day) == {**day, "accounts": {"B": day["accounts"]["B"]}}
    # A's 5D chain starts before the window; B is still on Friday, inside it.
    window = {
        "start_day": "2026-11-03",
        "day": "2026-11-09",
        "accounts": {
            "A": entry("2026-11-02T16:00:00Z", "2026-11-09T08:10:00Z"),
            "B": entry("2026-11-03T08:00:00Z", "2026-11-06T16:00:00Z"),
        },
    }
    assert set(within_trading_days(window)["accounts"]) == {"B"}
    assert within_trading_days({"accounts": day["accounts"]})["accounts"] == {}
    assert within_trading_days(None) is None


def test_the_same_observation_matches_across_timestamp_spellings():
    account = {"fetched_at_utc": "2026-11-04T15:50:00+00:00", "positions": [_position("NVDA")]}
    changes = holding_day_changes(_attribution(_row("NVDA", "1.00", "10.00")), {"A": account})
    assert changes["A"][0] == DayChange(1.0, pytest.approx(0.1), "2026-11-04")


def test_pounds_only_without_an_opening_value_and_no_share_of_a_zero_opening():
    changes = holding_day_changes(
        _attribution(_row("NVDA", "12.34"), _row("NEW", "0.00", "0.00")),
        {"A": _account(_position("NVDA"), _position("NEW"), _position("CASH"))},
    )
    assert changes["A"] == [
        DayChange(12.34, None, "2026-11-04"),
        DayChange(0.0, None, "2026-11-04"),
        None,
    ]
