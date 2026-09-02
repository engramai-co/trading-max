from datetime import UTC

import numpy as np
import pandas as pd
from trading_max.research.market import MarketResearchService, _gbp_benchmark_series


def _history(ticker: str, _period: str) -> pd.DataFrame:
    index = pd.date_range("2023-01-01", periods=760, freq="B", tz=UTC)
    if ticker == "GBPUSD=X":
        close = np.full(len(index), 2.0)
        return pd.DataFrame(
            {
                "Open": close,
                "High": close,
                "Low": close,
                "Close": close,
                "Volume": np.zeros(len(index)),
            },
            index=index,
        )
    base = {"SPY": 400.0, "QQQ": 350.0, "SOXX": 450.0}.get(ticker, 100.0)
    close = base + np.linspace(0, 25, len(index))
    return pd.DataFrame(
        {
            "Open": close - 1,
            "High": close + 1,
            "Low": close - 2,
            "Close": close,
            "Volume": np.full(len(index), 1_000_000.0),
        },
        index=index,
    )


def test_market_service_returns_typed_batches_without_network() -> None:
    service = MarketResearchService(
        history_loader=_history,
        options_loader=lambda ticker, yf_ticker, spot: (_ for _ in ()).throw(
            RuntimeError("fixture has no option chain")
        ),
        adr_loader=lambda ticker, frame, period: None,
    )

    technical, options = service.run(["BE", "TSM"], include_options=True)

    assert technical.tickers == ["BE", "TSM"]
    assert [row.ticker for row in technical.rows] == ["BE", "TSM"]
    assert technical.rows[0].technical_score >= 0
    assert set(technical.benchmark_series) == {"VOO", "QQQ", "VT"}
    assert len(technical.benchmark_series["VOO"]) == 760
    assert technical.benchmark_series["VOO"][0]["date"] == "2023-01-02"
    assert technical.benchmark_series["VOO"][0]["close"] == 50.0
    assert technical.benchmark_currency == "GBP"
    assert technical.benchmark_return_basis == "auto_adjusted_close"
    assert technical.benchmark_fx_ticker == "GBPUSD=X"
    assert options.rows == []
    assert any("options unavailable" in warning for warning in options.warnings)


def test_gbp_benchmark_preserves_fx_only_weekdays_without_duplicate_dates() -> None:
    asset_index = pd.DatetimeIndex(["2026-08-03 00:00:00-04:00", "2026-08-05 00:00:00-04:00"])
    fx_index = pd.date_range("2026-08-03", periods=3, freq="D", tz=UTC)
    asset = pd.DataFrame({"Close": [100.0, 110.0]}, index=asset_index)
    fx = pd.DataFrame({"Close": [2.0, 2.0, 2.0]}, index=fx_index)

    points = _gbp_benchmark_series(asset, fx)

    assert [point["date"] for point in points] == [
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
    ]
    assert [point["close"] for point in points] == [50.0, 50.0, 55.0]
