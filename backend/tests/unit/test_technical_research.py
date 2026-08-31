from datetime import UTC, date

import numpy as np
import pandas as pd
from trading_max.research.technical import (
    _clean_contracts,
    _contract_rows,
    _expiry_summary,
    _option_gex,
    analyze_ticker,
    history_coverage,
)


def synthetic_bars(rows: int = 320) -> pd.DataFrame:
    index = pd.date_range("2025-01-01", periods=rows, freq="B", tz="UTC")
    close = pd.Series(100 + np.arange(rows) * 0.15 + np.sin(np.arange(rows)), index=index)
    return pd.DataFrame(
        {
            "Open": close - 0.25,
            "High": close + 1.0,
            "Low": close - 1.0,
            "Close": close,
            "Volume": 1_000_000 + np.arange(rows) * 100,
        },
        index=index,
    )


def test_technical_artifact_calculates_indicators_from_fixture_bars() -> None:
    frame = synthetic_bars()
    benchmarks = {
        "SPY": frame["Close"] * 0.98,
        "QQQ": frame["Close"] * 0.99,
        "SOXX": frame["Close"] * 0.97,
    }

    artifact = analyze_ticker("TEST", "TEST", frame, benchmarks)

    assert artifact.ticker == "TEST"
    assert artifact.as_of == str(frame.index[-1].date())
    assert artifact.price is not None
    assert artifact.momentum["rsi14"] is not None
    assert artifact.moving_averages["sma200"] is not None
    assert 0 <= artifact.technical_score <= 100
    assert artifact.generated_at.tzinfo == UTC


def test_history_coverage_marks_short_requested_period_without_backfill() -> None:
    frame = synthetic_bars(80)

    coverage = history_coverage("TEST", frame, "3y")

    assert coverage["complete"] is False
    assert "genuine trading sessions" in coverage["warning"]


def test_options_gex_proxy_is_signed_by_contract_side() -> None:
    options = pd.DataFrame(
        {
            "strike": [100.0, 100.0],
            "open_interest": [100.0, 100.0],
            "volume": [10.0, 10.0],
            "iv": [0.3, 0.3],
            "years": [0.25, 0.25],
            "side": ["call", "put"],
        }
    )

    gex = _option_gex(options, 100.0)
    summary = _expiry_summary(options, "2099-01-01", 100.0)

    assert gex.iloc[0] > 0
    assert gex.iloc[1] < 0
    assert summary["call_open_interest"] == 100.0
    assert summary["put_open_interest"] == 100.0
    assert summary["net_gex_1pct_proxy"] == 0.0


def test_option_contract_rows_preserve_observed_chain_fields() -> None:
    frame = pd.DataFrame(
        {
            "contractSymbol": ["TEST260918C00100000"],
            "strike": [100.0],
            "lastPrice": [4.8],
            "bid": [4.7],
            "ask": [4.9],
            "openInterest": [125],
            "volume": [31],
            "impliedVolatility": [0.42],
            "inTheMoney": [True],
        }
    )

    cleaned = _clean_contracts(frame, "call", date(2099, 1, 1))
    cleaned["expiry"] = "2099-01-01"
    rows = _contract_rows(cleaned)

    assert rows == [
        {
            "expiry": "2099-01-01",
            "side": "call",
            "contract_symbol": "TEST260918C00100000",
            "strike": 100.0,
            "last_price": 4.8,
            "bid": 4.7,
            "ask": 4.9,
            "open_interest": 125.0,
            "volume": 31.0,
            "iv": 0.42,
            "in_the_money": True,
        }
    ]
