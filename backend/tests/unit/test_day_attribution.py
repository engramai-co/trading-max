from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from trading_max.analytics.day_attribution import (
    ShareMovement,
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


def _fill(action, quantity, at="2026-11-02T12:00:00Z"):
    return ShareMovement(datetime.fromisoformat(at), "", action, Decimal(quantity))


def _contributions(attribution, code="A"):
    return {row.ticker: row.contribution_gbp for row in attribution.accounts[code].contributions}


def _saved(model):
    """An artifact as the stage stores it and reads it back on its next run."""

    return model.model_dump(mode="json", by_alias=False)


def _two_accounts(a_at: str, a_value: str, b_at: str, b_value: str):
    """Account A holding one NVDA share and account B one EQGB share, each observed on its own."""

    return {
        "A": _account(a_at, ("NVDA", "1", a_value)),
        "B": _account(b_at, ("EQGB", "1", b_value)),
    }


def _stored_opening(captured_at: str, ticker: str, value: str):
    return {
        "captured_at": captured_at,
        "positions": [
            {
                "key": ticker + "_US_EQ",
                "ticker": ticker,
                "name": ticker + " Inc",
                "quantity": "1",
                "value_gbp": value,
            }
        ],
    }


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
        share_movements={"A": {"NVDA": (_fill("buy", 5),)}},
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
        share_movements={"A": {"NVDA": (_fill("buy", 5),), "SOFI": (_fill("sell", 20),)}},
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


def test_an_account_still_on_friday_opens_monday_at_its_own_first_monday_observation():
    friday, _ = update_day_attribution(
        None, _two_accounts("2026-11-06T08:00:00Z", "100.00", "2026-11-06T08:00:00Z", "50.00")
    )
    # B reaches Monday while A still shows Friday's last observation.
    monday, attribution = update_day_attribution(
        _saved(friday),
        _two_accounts("2026-11-06T16:00:00Z", "100.00", "2026-11-09T08:00:00Z", "52.00"),
    )
    assert attribution.day.isoformat() == "2026-11-09"
    assert set(monday.accounts) == set(attribution.accounts) == {"B"}
    # A's first Monday observation opens A's Monday: Friday's £100 is no basis for it.
    monday, attribution = update_day_attribution(
        _saved(monday),
        _two_accounts("2026-11-09T08:10:00Z", "110.00", "2026-11-09T08:10:00Z", "53.00"),
    )
    assert attribution.accounts["A"].since.isoformat().startswith("2026-11-09T08:10")
    assert _contributions(attribution) == {"NVDA": Decimal("0.00")}
    assert _contributions(attribution, "B") == {"EQGB": Decimal("1.00")}
    _, attribution = update_day_attribution(
        _saved(monday),
        _two_accounts("2026-11-09T15:00:00Z", "115.00", "2026-11-09T15:00:00Z", "51.00"),
    )
    row = attribution.accounts["A"].contributions[0]
    assert (row.contribution_gbp, row.opening_value_gbp) == (Decimal("5.00"), Decimal("110.00"))


def test_weekend_observations_stay_on_friday_until_each_account_reaches_monday():
    friday, _ = update_day_attribution(
        None, _two_accounts("2026-11-06T08:00:00Z", "100.00", "2026-11-06T08:00:00Z", "50.00")
    )
    # B's Saturday observation and A's last Friday one share Friday's trading day.
    weekend, attribution = update_day_attribution(
        _saved(friday),
        _two_accounts("2026-11-06T20:00:00Z", "104.00", "2026-11-07T10:00:00Z", "49.00"),
    )
    assert attribution.day.isoformat() == "2026-11-06"
    assert _contributions(attribution) == {"NVDA": Decimal("4.00")}
    assert _contributions(attribution, "B") == {"EQGB": Decimal("-1.00")}
    # B's first Monday observation opens Monday; A's Sunday observation still
    # belongs to Friday, so A waits for its own.
    _, attribution = update_day_attribution(
        _saved(weekend),
        _two_accounts("2026-11-08T12:00:00Z", "104.00", "2026-11-09T00:10:00Z", "49.50"),
    )
    assert attribution.day.isoformat() == "2026-11-09"
    assert set(attribution.accounts) == {"B"}
    assert _contributions(attribution, "B") == {"EQGB": Decimal("0.00")}


def test_an_opening_stored_under_a_later_trading_day_never_opens_it():
    # Written before openings were kept per account: A's Friday observation stored
    # as its Monday opening beside B's real one.
    legacy = {
        "schema_version": 1,
        "day": "2026-11-09",
        "accounts": {
            "A": _stored_opening("2026-11-06T16:00:00Z", "NVDA", "100.00"),
            "B": _stored_opening("2026-11-09T08:00:00Z", "EQGB", "50.00"),
        },
    }
    baseline, attribution = update_day_attribution(
        legacy, _two_accounts("2026-11-09T08:10:00Z", "110.00", "2026-11-09T08:10:00Z", "52.00")
    )
    assert baseline.accounts["A"].captured_at.isoformat().startswith("2026-11-09T08:10")
    assert _contributions(attribution) == {"NVDA": Decimal("0.00")}
    assert _contributions(attribution, "B") == {"EQGB": Decimal("2.00")}


def _window(previous, current, *, history=None, share_movements=None):
    """Open or carry the day, then chain the 5D window up to the current observation."""

    baseline, _ = update_day_attribution(previous and previous["day"], current)
    window_baselines, window = update_window_attribution(
        previous and previous["window"],
        baseline,
        current,
        history=history,
        share_movements=share_movements,
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
        state,
        {"A": _account("2026-11-03T15:00:00Z", ("NVDA", "20", "3000.00"))},
        share_movements={"A": {"NVDA": (_fill("buy", 10),)}},
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


def test_window_chains_an_account_still_on_friday_up_to_its_own_observation():
    state, _ = _window(
        None, _two_accounts("2026-11-06T08:00:00Z", "100.00", "2026-11-06T08:00:00Z", "50.00")
    )
    state, window = _window(
        state, _two_accounts("2026-11-06T16:00:00Z", "104.00", "2026-11-09T08:00:00Z", "52.00")
    )
    # Monday holds no opening for A, whose chain ends at its own Friday observation.
    assert "A" not in state["window"]["days"][-1]["accounts"]
    assert window.accounts["A"].as_of.isoformat().startswith("2026-11-06T16:00")
    assert _contributions(window) == {"NVDA": Decimal("4.00")}
    # A's first Monday observation becomes its Monday opening. The 5D window spans
    # Friday and Monday, so the move between them still counts there.
    state, window = _window(
        state, _two_accounts("2026-11-09T08:10:00Z", "110.00", "2026-11-09T08:10:00Z", "53.00")
    )
    monday = state["window"]["days"][-1]["accounts"]["A"]
    assert monday["captured_at"].startswith("2026-11-09T08:10")
    assert _contributions(window) == {"NVDA": Decimal("10.00")}


def test_window_never_starts_from_an_opening_stored_under_another_trading_day():
    def stored(day: str, captured_at: str, value: str):
        return {"day": day, "accounts": {"A": _stored_opening(captured_at, "NVDA", value)}}

    # Written before openings were kept per account: A's observation of Monday
    # 2 November stored as its opening of Tuesday 3 November, the window's first day.
    previous = {
        "day": stored("2026-11-06", "2026-11-06T08:00:00Z", "100.00"),
        "window": {
            "days": [
                stored("2026-11-03", "2026-11-02T16:00:00Z", "90.00"),
                stored("2026-11-06", "2026-11-06T08:00:00Z", "100.00"),
            ]
        },
    }
    state, window = _window(
        previous, {"A": _account("2026-11-09T10:00:00Z", ("NVDA", "1", "110.00"))}
    )
    # Friday's opening starts the chain: 100 to 110, not 90 from before the window.
    assert window.accounts["A"].since.isoformat().startswith("2026-11-06T08:00")
    assert _contributions(window) == {"NVDA": Decimal("10.00")}
    assert {
        day["day"]: day["accounts"]["A"]["captured_at"][:10]
        for day in state["window"]["days"]
        if "A" in day["accounts"]
    } == {"2026-11-06": "2026-11-06", "2026-11-09": "2026-11-09"}


def test_fx_effect_reconciles_to_position_contribution_for_held_shares_and_chained_days():
    def account(day, quantity, native, gbp_per_usd):
        value = int(quantity * native * gbp_per_usd)
        result = _account(day, ("SYN", str(quantity), str(value)))
        result["positions"][0].update(current_price=str(native), price_currency="USD")
        return {"B": result}

    first = account("2026-11-02T08:00:00Z", 10, 100, 0.8)
    next_day = account("2026-11-03T08:00:00Z", 15, 110, 0.7)
    last = account("2026-11-03T16:00:00Z", 12, 120, 0.75)
    opening, _ = update_day_attribution(None, first)
    saved, _ = update_window_attribution(None, opening, first)
    second, _ = update_day_attribution(_saved(opening), next_day)
    fills = {"B": {"SYN": (_fill("buy", 5), _fill("sell", 3, "2026-11-03T12:00:00Z"))}}
    _, daily = update_day_attribution(_saved(second), last, share_movements=fills)
    _, window = update_window_attribution(_saved(saved), second, last, share_movements=fills)
    row = daily.accounts["B"].contributions[0]
    assert (row.local_price_effect_gbp, row.fx_effect_gbp, row.contribution_gbp) == (90, 66, 156)
    # First segment's ten held shares gained £70 on price and lost £100 in FX.
    chained = window.accounts["B"].contributions[0]
    assert (chained.local_price_effect_gbp, chained.fx_effect_gbp, chained.contribution_gbp) == (
        160,
        -34,
        126,
    )
    old, _ = update_day_attribution(
        None, {"B": _account("2026-11-03T08:00:00Z", ("SYN", "15", "1155"))}
    )
    _, mixed = update_day_attribution(_saved(old), last, share_movements=fills)
    assert mixed.accounts["B"].contributions[0].fx_effect_gbp is None


def test_open_position_uses_broker_fx_then_native_cost_basis():
    from trading_max.analytics.accounts import _position_metrics
    from trading_max.ingestion.brokers.trading212 import _position_from_payload

    raw = {
        "instrument": {"ticker": "SYN_US_EQ", "currency": "USD"},
        "quantity": 10,
        "currentPrice": 110,
        "averagePricePaid": 100,
        "walletImpact": {"totalCost": 800, "currentValue": 770, "unrealizedProfitLoss": -30},
    }
    assert _position_metrics(_position_from_payload(raw)).fx_impact_gbp == -100
    raw["walletImpact"]["fxImpact"] = -99
    assert _position_metrics(_position_from_payload(raw)).fx_impact_gbp == -99
    del raw["averagePricePaid"], raw["walletImpact"]["fxImpact"]
    assert _position_metrics(_position_from_payload(raw)).fx_impact_gbp is None
    raw["instrument"]["currency"] = "GBX"
    assert _position_metrics(_position_from_payload(raw)).fx_impact_gbp == 0


def test_split_changes_share_units_before_daily_and_window_fx_and_withholds_uncertain_units():
    def account(at, qty, price, pounds, average, cost):
        result = _account(at, ("SYN", str(qty), str(pounds)))
        result["positions"][0].update(
            current_price=str(price),
            price_currency="USD",
            average_price_paid=average,
            total_cost_gbp=cost,
        )
        return {"A": result}

    before = account("2026-11-02T08:00:00Z", 10, 100, 800, 80, 640)
    after = account("2026-11-02T17:00:00Z", 20, 50, 700, 40, 640)
    opening, _ = update_day_attribution(None, before)
    _, daily = update_day_attribution(_saved(opening), after)
    _, five = update_window_attribution(None, opening, after)
    for result in (daily, five):
        row = result.accounts["A"].contributions[0]
        assert (row.contribution_gbp, row.local_price_effect_gbp, row.fx_effect_gbp) == (
            -100,
            0,
            -100,
        )
    next_day = account("2026-11-03T08:00:00Z", 20, 55, 770, 40, 640)
    saved, _ = update_window_attribution(None, opening, before)
    new_opening, _ = update_day_attribution(_saved(opening), next_day)
    _, window = update_window_attribution(_saved(saved), new_opening, next_day)
    row = window.accounts["A"].contributions[0]
    assert (row.contribution_gbp, row.local_price_effect_gbp, row.fx_effect_gbp) == (-30, 70, -100)
    after["A"]["positions"][0]["average_price_paid"] = None
    _, daily = update_day_attribution(_saved(opening), after)
    _, five = update_window_attribution(None, opening, after)
    for result in (daily, five):
        assert result.accounts["A"].contributions == []
        assert result.accounts["A"].unreconciled_instruments == ["SYN_US_EQ"]


def test_reported_broker_split_reconciles_exact_share_units_across_window(tmp_path):
    from trading_max.application.nav_stages import broker_share_movements

    path = tmp_path / "synthetic.csv"
    path.write_text(
        "Action,Time (UTC),Ticker,ISIN,No. of shares,Total\n"
        "Stock split close,2026-11-03T07:01:00Z,SYN,TEST00000001,10,0\n"
        "Stock split open,2026-11-03T07:01:01Z,SYN,TEST00000001,20,0\n"
    )
    legs = {"A": broker_share_movements(path, path.stat().st_mtime_ns, path.stat().st_size)}

    def account(at, qty, price, value):
        raw = _account(at, ("SYN", str(qty), str(value)))
        raw["positions"][0].update(
            isin="TEST00000001", current_price=str(price), price_currency="USD"
        )
        return {"A": raw}

    first = account("2026-11-02T09:00:00Z", 10, 100, 800)
    opening, _ = update_day_attribution(None, first)
    saved, _ = update_window_attribution(None, opening, first)
    for qty in (20, 17):
        after = account("2026-11-03T08:00:00Z", qty, 50, qty * 35)
        today, _ = update_day_attribution(_saved(opening), after)
        _, window = update_window_attribution(_saved(saved), today, after, share_movements=legs)
        if qty == 20:
            row = window.accounts["A"].contributions[0]
            assert (row.contribution_gbp, row.local_price_effect_gbp, row.fx_effect_gbp) == (
                -100,
                0,
                -100,
            )
        else:
            assert not window.accounts["A"].contributions
            assert window.accounts["A"].unreconciled_instruments == ["SYN_US_EQ"]


def test_unverified_five_for_four_share_change_cannot_create_a_price_loss():
    before = _account("2026-11-02T08:00:00Z", ("SYN", "4", "320"))
    after = _account("2026-11-02T16:00:00Z", ("SYN", "5", "300"))
    for raw, price in ((before, 100), (after, 80)):
        raw["positions"][0].update(current_price=price, price_currency="USD")
    opening, _ = update_day_attribution(None, {"A": before})
    _, day = update_day_attribution(_saved(opening), {"A": after})
    assert day.accounts["A"].unreconciled_instruments == ["SYN_US_EQ"]
    assert not day.accounts["A"].contributions


def test_legacy_opening_with_changed_share_units_requires_reconciling_broker_activity(tmp_path):
    from trading_max.application.nav_stages import broker_share_movements

    before = _account("2026-11-02T08:00:00Z", ("SYN", "10", "800"))
    after = _account("2026-11-02T16:00:00Z", ("SYN", "20", "700"))
    after["positions"][0].update(current_price=50, price_currency="USD", isin="TEST00000001")
    opening, _ = update_day_attribution(None, {"A": before})
    saved = _saved(opening)
    old = saved["accounts"]["A"]["positions"][0]
    for attr in ("isin", "average_price_paid", "total_cost_gbp", "price_currency", "local_price"):
        old.pop(attr)
    _, ambiguous = update_day_attribution(saved, {"A": after})
    assert not ambiguous.accounts["A"].contributions
    assert ambiguous.accounts["A"].unreconciled_instruments == ["SYN_US_EQ"]
    path = tmp_path / "fills.csv"
    path.write_text(
        "Action,Time (UTC),Ticker,ISIN,No. of shares,Total\n"
        "Stock split close,2026-11-02T12:00:00Z,SYN,TEST00000001,10,0\n"
        "Stock split open,2026-11-02T12:00:01Z,SYN,TEST00000001,20,0\n"
    )
    legs = {"A": broker_share_movements(path, path.stat().st_mtime_ns, path.stat().st_size)}
    _, resolved = update_day_attribution(saved, {"A": after}, share_movements=legs)
    assert _contributions(resolved) == {"SYN": Decimal("-100")}


def test_executed_purchase_quantities_reconcile_despite_native_quote_fall(tmp_path):
    from trading_max.application.nav_stages import broker_share_movements

    before = _account("2026-11-02T08:00:00Z", ("SYN", "10", "800"))
    after = _account("2026-11-02T16:00:00Z", ("SYN", "20", "1440"))
    for account, price in ((before, 100), (after, 55)):
        account["positions"][0].update(
            current_price=price, price_currency="USD", isin="TEST00000001"
        )
    path = tmp_path / "fills.csv"
    path.write_text(
        "Action,Time (UTC),Ticker,ISIN,No. of shares,Total\n"
        "Market buy,2026-11-02T10:00:00Z,SYN,TEST00000001,6,300\n"
        "Limit buy,2026-11-02T12:00:00Z,SYN,TEST00000001,4,200\n"
    )
    legs = {"A": broker_share_movements(path, path.stat().st_mtime_ns, path.stat().st_size)}
    opening, _ = update_day_attribution(None, {"A": before})
    _, daily = update_day_attribution(_saved(opening), {"A": after}, share_movements=legs)
    _, window = update_window_attribution(None, opening, {"A": after}, share_movements=legs)
    for result in (daily, window):
        assert _contributions(result) == {"SYN": Decimal("-80")}
