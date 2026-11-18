from datetime import UTC, datetime

import pandas as pd
import pytest
from trading_max.research.calendar import (
    completed_daily_bars,
    completed_months,
    listing_calendar,
    listing_venues,
    session_schedule,
)
from trading_max.research.technical import _rsi, price_series


def test_exchange_month_closes_on_last_session_and_holiday_is_not_missing():
    # March 2024 ended on Sunday; Friday was Good Friday (NYSE closed).
    close = pd.Series(
        [100, 110, 125], index=pd.to_datetime(["2024-02-29", "2024-03-28", "2024-04-15"])
    )
    result = completed_months(close, exchange="NYQ", now=pd.Timestamp("2024-04-16T12:00:00Z"))
    assert list(result.index.strftime("%Y-%m")) == ["2024-03"]
    assert result.iloc[0] == pytest.approx(0.1)
    before_close = completed_months(
        close.iloc[:2], exchange="NYQ", now=pd.Timestamp("2024-03-28T19:30:00Z")
    )
    assert before_close.empty


def test_missing_month_end_does_not_turn_a_partial_snapshot_into_a_full_return():
    close = pd.Series(
        [100, 110, 120, 150],
        index=pd.to_datetime(["2024-01-31", "2024-02-27", "2024-03-28", "2024-04-30"]),
    )
    result = completed_months(close, exchange="NYQ", now=pd.Timestamp("2025-01-01T12:00:00Z"))
    assert list(result.index.strftime("%Y-%m")) == ["2024-04"]
    assert result.iloc[0] == 0.25


def test_indicator_warmup_is_missing_and_exported_rsi_matches_snapshot_calculation():
    index = pd.bdate_range("2024-01-01", periods=70)
    frame = pd.DataFrame(
        {
            "Close": [100 + i / 10 for i in range(70)],
            "Open": 100,
            "High": 110,
            "Low": 90,
            "Volume": 100,
        },
        index=index,
    )
    result = price_series(frame, {}, sessions=70)
    assert all(p["rsi14"] is None for p in result[:14])
    assert result[-1]["rsi14"] == _rsi(frame.Close).iloc[-1] == 100
    assert all(p["macdSignal"] is None for p in result[:33])


def test_daily_observations_wait_for_actual_close_including_short_sessions():
    frame = pd.DataFrame(
        {"Close": [100, 101]},
        index=pd.to_datetime(["2024-07-02", "2024-07-03"]).tz_localize("America/New_York"),
    )
    frame.attrs["exchange"] = "NYQ"
    assert len(completed_daily_bars(frame, now=pd.Timestamp("2024-07-03T16:59:00Z"))) == 1
    assert len(completed_daily_bars(frame, now=pd.Timestamp("2024-07-03T17:01:00Z"))) == 2
    assert len(frame) == 2
    frame.attrs.clear()
    assert len(completed_daily_bars(frame, now=pd.Timestamp("2024-07-03T20:01:00Z"))) == 1
    assert len(completed_daily_bars(frame, now=pd.Timestamp("2024-07-04T20:01:00Z"))) == 2


def test_session_schedule_skips_thanksgiving_and_keeps_its_early_close():
    schedule = session_schedule("XNYS", datetime(2026, 11, 26, 16, tzinfo=UTC))
    assert schedule is not None and schedule.calendar == "XNYS"
    sessions = {session.date: session for session in schedule.sessions}
    assert "2026-11-26" not in sessions
    assert sessions["2026-11-25"].open == "2026-11-25T14:30:00Z"
    assert sessions["2026-11-25"].close == "2026-11-25T21:00:00Z"
    # The day after Thanksgiving closes at 13:00 in New York.
    assert sessions["2026-11-27"].close == "2026-11-27T18:00:00Z"
    # Two weeks back and ten days ahead, weekends excluded.
    assert schedule.sessions[0].date == "2026-11-12"
    assert schedule.sessions[-1].date == "2026-12-04"
    # Complete until the next session after Friday 4 December opens.
    assert schedule.until == "2026-12-07T14:30:00Z"


def test_session_schedule_names_where_its_coverage_ends():
    # Built on Wednesday 4 November: the last listed session is Friday 13 November,
    # and Monday 16 November is the first session it does not cover.
    schedule = session_schedule("XNYS", datetime(2026, 11, 4, 16, tzinfo=UTC))
    assert schedule is not None
    assert schedule.sessions[-1].date == "2026-11-13"
    assert schedule.until == "2026-11-16T14:30:00Z"


def test_session_schedule_skips_uk_bank_holidays():
    summer = session_schedule("XLON", datetime(2026, 8, 31, 11, tzinfo=UTC))
    assert summer is not None
    dates = [session.date for session in summer.sessions]
    assert "2026-08-28" in dates and "2026-08-31" not in dates and "2026-09-01" in dates
    assert summer.sessions[dates.index("2026-09-01")].open == "2026-09-01T07:00:00Z"
    christmas = session_schedule("XLON", datetime(2026, 12, 24, 9, tzinfo=UTC))
    assert christmas is not None
    by_date = {session.date: session for session in christmas.sessions}
    assert by_date["2026-12-24"].close == "2026-12-24T12:30:00Z"
    assert "2026-12-25" not in by_date and "2026-12-28" not in by_date


def test_listing_calendar_reads_observed_venues_and_qualified_symbols():
    assert listing_calendar("AAPL", "NasdaqGS", "America/New_York") == "XNYS"
    assert listing_calendar("IAG", "NYSE", None) == "XNYS"
    assert listing_calendar("IAG.L", "LSE", "Europe/London") == "XLON"
    assert listing_calendar("IAG.L", None, None) == "XLON"
    assert listing_calendar("SAP.DE", "XETRA", "Europe/Berlin") == "XETR"
    assert listing_calendar("SYN", None, "Europe/Berlin") is None
    # Unknown exchanges have no calendar and no schedule.
    assert listing_calendar("OLYM", "Olympus", "Mars/Olympus") is None
    assert session_schedule(None, datetime(2026, 11, 4, tzinfo=UTC)) is None


@pytest.mark.parametrize(
    ("code", "suffix", "expected"),
    [
        ("FRA", "F", "XFRA"),
        ("GER", "DE", "XETR"),
        ("LSE", "L", "XLON"),
        ("AMS", "AS", "XAMS"),
        ("BRU", "BR", "XBRU"),
        ("MCE", "MC", "XMAD"),
        ("STO", "ST", "XSTO"),
        ("HKG", "HK", "XHKG"),
        ("JPX", "T", "XTKS"),
        ("ASX", "AX", "XASX"),
        ("TOR", "TO", "XTSE"),
        ("PAR", "PA", "XPAR"),
        ("MIL", "MI", "XMIL"),
        ("EBS", "SW", "XSWX"),
        ("KOREA EXCHANGE (KOSDAQ)", "KQ", "XKRX"),
        ("WARSAW", "WA", "XWAR"),
    ],
)
def test_yahoo_venues_and_qualified_fund_symbols(code, suffix, expected):
    assert listing_calendar("SYN", code, None) == expected
    assert listing_calendar("SYN." + suffix, None, None) == expected
    assert listing_calendar("SYN", expected, None) == expected


def test_frankfurt_equity_hours_include_evenings_and_holiday_early_closes():
    def session(day):
        schedule = session_schedule("XFRA", datetime.fromisoformat(day + "T12:00:00+00:00"))
        return next(s for s in schedule.sessions if s.date == day)

    assert session("2021-11-26").close == "2021-11-26T19:00:00Z"
    assert session("2021-11-29").close == "2021-11-29T21:00:00Z"
    assert session("2026-05-13").open == "2026-05-13T06:00:00Z"
    assert session("2026-05-13").close == "2026-05-13T20:00:00Z"
    assert session("2026-05-14").close == "2026-05-14T18:00:00Z"
    assert session("2026-12-30").close == "2026-12-30T13:00:00Z"


def test_venue_identity_distinguishes_exchanges_with_shared_closes_and_market_composites():
    nyse = listing_venues("SYN", "UN")
    assert nyse == listing_venues("SYN", "NYQ") == {"XNYS"}
    assert listing_venues("SYN", "UW") == listing_venues("SYN", "NasdaqGS") == {"XNGS"}
    assert nyse.isdisjoint(listing_venues("SYN", "UW"))
    assert listing_venues("SYN", "US") & nyse
    assert listing_venues("SYN.L", "LN").isdisjoint(listing_venues("SYN", "US"))
    assert listing_venues("SYN", "GF") == {"XFRA"}
    assert listing_venues("SYN", "GR") & listing_venues("SYN", "GY")
    assert not listing_venues("SYN", "unverified")


def test_openfigi_soma_is_distinct_from_bombay():
    assert listing_venues("SYN", "BO") == {"XSOM"}
    assert listing_venues("SYN.BO", None) == {"XBOM"}


def test_month_end_checks_all_exchange_evidence_before_admitting_final_month():
    close = pd.Series([100, 110], index=pd.to_datetime(["2024-02-29", "2024-03-28"]))
    close.attrs.update(
        ticker="SYN.L",
        provider_venue={"symbol": "SYN.L", "exchangeName": "LSE", "fullExchangeName": "UNVERIFIED"},
    )
    assert completed_months(close, exchange="LSE", now=pd.Timestamp("2024-03-29T20:00Z")).empty
