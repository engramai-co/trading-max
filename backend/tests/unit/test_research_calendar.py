import pandas as pd
import pytest
from trading_max.research.calendar import completed_daily_bars, completed_months
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
