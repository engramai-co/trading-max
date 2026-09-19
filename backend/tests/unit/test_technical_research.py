from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from trading_max.research.technical import (
    _clean_contracts,
    _contract_rows,
    _expiry_summary,
    _option_gex,
    analyze_options,
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


def test_history_carries_provider_currency_and_normalizes_pence(monkeypatch):
    from trading_max.research.technical import history

    original = synthetic_bars(80)

    class Security:
        def history(self, **_kwargs):
            return original.copy()

        def get_history_metadata(self):
            return {"currency": "GBp"}

    monkeypatch.setattr("trading_max.research.technical.yf.Ticker", lambda _ticker: Security())
    bars = history("SYNTHETIC.L")
    assert bars.attrs["currency"] == "GBP"
    assert bars["Close"].iloc[-1] == original["Close"].iloc[-1] / 100
    assert bars["Volume"].equals(original["Volume"])
    benchmarks = dict.fromkeys(("SPY", "QQQ", "SOXX"), bars["Close"])
    assert analyze_ticker("SYNTHETIC.L", "SYNTHETIC.L", bars, benchmarks).currency == "GBP"
    bars.attrs.clear()
    assert analyze_ticker("UNKNOWN", "UNKNOWN", bars, benchmarks).currency == ""


def test_options_gex_proxy_is_signed_by_contract_side() -> None:
    options = pd.DataFrame(
        {
            "strike": [100.0, 100.0],
            "open_interest": [100.0, 100.0],
            "volume": [10.0, 10.0],
            "iv": [0.3, 0.3],
            "years": [0.25, 0.25],
            "multiplier": [100, 100],
            "risk_free_rate": [0.04, 0.04],
            "dividend_yield": [0, 0],
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
            "last_trade_at": None,
            "quote_as_of": None,
            "open_interest_as_of": None,
            "multiplier": None,
            "exercise_style": None,
            "settlement": None,
            "expiry_instant": None,
            "terms_state": "unsupported",
            "currency": None,
            "gamma": None,
            "delta": None,
            "gex_1pct": None,
        }
    ]


def test_up_down_volume_ratio_uses_the_same_last_twenty_sessions() -> None:
    frame = synthetic_bars(80)
    frame["Close"] = 200 + np.cumsum([-1] * 60 + [1] * 15 + [-1] * 5)
    frame["High"] = frame["Close"] + 1
    frame["Low"] = frame["Close"] - 1
    frame["Volume"] = [10_000] * 60 + [100] * 20
    benchmarks = dict.fromkeys(("SPY", "QQQ", "SOXX"), frame["Close"])

    result = analyze_ticker("TEST", "TEST", frame, benchmarks)

    assert result.volume["up_down_volume_ratio_20d"] == 3
    assert "上涨日量能占优" in result.signals


@pytest.mark.parametrize("open_interest", [[None, 10], [0, 0]])
def test_max_pain_requires_complete_positive_open_interest(open_interest) -> None:
    options = pd.DataFrame(
        {
            "strike": [100, 110],
            "side": ["call", "put"],
            "open_interest": open_interest,
            "volume": [0, 0],
            "iv": [0.3, 0.3],
        }
    )
    assert _expiry_summary(options, "2099-01-01", 100)["max_pain_proxy"] is None


def test_unavailable_option_gex_does_not_become_positive_gamma(monkeypatch) -> None:
    expiry = (datetime.now(UTC).date() + timedelta(days=7)).isoformat()
    raw = pd.DataFrame(
        {
            "contractSymbol": ["UNSUPPORTED"],
            "strike": [100],
            "openInterest": [10],
            "volume": [1],
            "impliedVolatility": [0.3],
        }
    )
    security = SimpleNamespace(
        info={"quoteType": "EQUITY", "exchange": "NMS", "currency": "USD"},
        options=[expiry],
        option_chain=lambda _expiry: SimpleNamespace(calls=raw, puts=pd.DataFrame()),
    )
    monkeypatch.setattr("trading_max.research.technical.yf.Ticker", lambda _symbol: security)
    monkeypatch.setattr(
        "trading_max.research.technical.treasury_rate", lambda _day: {"value": None}
    )

    result = analyze_options("TEST", "TEST", 100)

    assert result.aggregate["net_gex_1pct_proxy"] is None
    assert result.gamma_proxy["gamma_regime"] is None
