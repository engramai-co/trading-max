from datetime import UTC

import numpy as np
import pandas as pd
from trading_max.research.market import MarketResearchService


def _history(ticker: str, _period: str) -> pd.DataFrame:
    index = pd.date_range("2023-01-01", periods=760, freq="B", tz=UTC)
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
    assert options.rows == []
    assert any("options unavailable" in warning for warning in options.warnings)
