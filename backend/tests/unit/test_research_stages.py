from __future__ import annotations

from datetime import UTC

import numpy as np
import pandas as pd
import pytest
from trading_max.application import StageContext
from trading_max.application.research_stages import (
    AdrArtifactStage,
    AnalystArtifactStage,
    EarningsArtifactStage,
    FinancialsArtifactStage,
    FundamentalsArtifactStage,
    MarketSnapshotStage,
    OptionsArtifactStage,
    TechnicalArtifactStage,
    ValuationArtifactStage,
)
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.market import MarketResearchService
from trading_max.worker import StageExecutionError


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


def _context(*artifact_ids: str) -> StageContext:
    return StageContext(
        job_id="research-test",
        scope="research",
        tickers=("BE", "TSM"),
        upstream_artifact_ids=artifact_ids,
    )


class _CountingService:
    def __init__(self) -> None:
        self.calls = 0
        self.history_periods: list[str] = []
        self.service = MarketResearchService(
            history_loader=self._load_history,
            options_loader=lambda ticker, yf_ticker, spot: (_ for _ in ()).throw(
                RuntimeError("fixture has no option chain")
            ),
            adr_loader=lambda ticker, frame, period: None,
        )

    def _load_history(self, ticker: str, period: str) -> pd.DataFrame:
        self.history_periods.append(period)
        return _history(ticker, period)

    def run(self, tickers):
        self.calls += 1
        return self.service.run(tickers)


def test_research_stages_use_one_immutable_market_input(tmp_path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    provider = _CountingService()

    market = MarketSnapshotStage(artifacts, provider)
    market_result = market.run(_context())
    assert provider.calls == 1
    assert set(provider.history_periods) == {"max"}
    market_ref = market_result.artifacts[0]
    assert market_ref.key == "research/market_snapshot.json"
    nav_csv = artifacts.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=b"Date,SyntheticNAVGBP\n2026-08-08,100\n",
        kind="nav_series",
        media_type="text/csv",
    )

    technical_result = TechnicalArtifactStage(artifacts).run(
        _context(nav_csv.ref.artifact_id, market_ref.artifact_id)
    )
    options_result = OptionsArtifactStage(artifacts).run(_context(market_ref.artifact_id))
    adr_result = AdrArtifactStage(artifacts).run(
        _context(market_ref.artifact_id, technical_result.artifacts[0].artifact_id)
    )

    assert technical_result.artifacts[0].key == "research/technical.json"
    technical_payload = artifacts.get_json(technical_result.artifacts[0].artifact_id).payload
    assert len(technical_payload["rows"][0]["seasonality"]) == 12
    assert technical_payload["rows"][0]["seasonality_coverage"] == {
        "basis": "full-listing-history",
        "first_session": "2023-01-02",
        "last_session": "2025-11-28",
        "daily_sessions": 760,
        "monthly_observations": 34,
    }
    assert set(technical_payload["benchmark_series"]) == {"VOO", "QQQ", "VT"}
    assert len(technical_payload["benchmark_series"]["VOO"]) == 760
    assert technical_payload["benchmark_currency"] == "GBP"
    assert technical_payload["benchmark_return_basis"] == "auto_adjusted_close"
    assert options_result.artifacts[0].key == "research/options.json"
    assert adr_result.artifacts[0].key == "research/adr.json"
    assert technical_result.artifacts[0].dependency_artifact_ids == [market_ref.artifact_id]
    assert options_result.artifacts[0].dependency_artifact_ids == [market_ref.artifact_id]


def test_technical_stage_fails_loudly_without_market_input(tmp_path) -> None:
    stage = TechnicalArtifactStage(ContentAddressedArtifactStore(tmp_path / "artifacts"))

    with pytest.raises(StageExecutionError, match="current market snapshot"):
        stage.run(_context())


def test_fundamentals_valuation_and_earnings_stages_are_dependency_bound(
    tmp_path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    market_result = MarketSnapshotStage(artifacts, _CountingService()).run(_context())
    market_ref = market_result.artifacts[0]
    technical_result = TechnicalArtifactStage(artifacts).run(_context(market_ref.artifact_id))
    service = YFinanceResearchService(
        info_loader=lambda ticker: {
            "longName": "Bloom Energy",
            "currency": "USD",
            "forwardPE": 18.5,
        },
        calendar_loader=lambda ticker: {"Earnings Date": "2026-09-01"},
    )
    fundamentals = FundamentalsArtifactStage(artifacts, service).run(
        _context(market_ref.artifact_id)
    )
    valuation = ValuationArtifactStage(artifacts).run(
        _context(
            market_ref.artifact_id,
            technical_result.artifacts[0].artifact_id,
            fundamentals.artifacts[0].artifact_id,
        )
    )
    earnings = EarningsArtifactStage(artifacts, service).run(_context())

    assert fundamentals.artifacts[0].key == "research/fundamentals.json"
    assert valuation.artifacts[0].key == "research/valuation.json"
    assert earnings.artifacts[0].key == "research/earnings.json"
    assert valuation.artifacts[0].dependency_artifact_ids == [
        technical_result.artifacts[0].artifact_id,
        fundamentals.artifacts[0].artifact_id,
    ]


def test_analyst_stage_publishes_consensus_artifact(tmp_path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    market_result = MarketSnapshotStage(artifacts, _CountingService()).run(_context())
    service = YFinanceResearchService(
        analyst_loader=lambda ticker: {
            "priceTargets": {"mean": 120.0},
            "recommendations": [],
        }
    )
    stage = AnalystArtifactStage(artifacts, service)
    result = stage.run(_context(market_result.artifacts[0].artifact_id))

    assert result.artifacts[0].key == "research/analyst.json"
    payload = artifacts.get_json(result.artifacts[0].artifact_id).payload
    assert payload["rows"][0]["analyst"]["priceTargets"]["mean"] == 120.0


def test_financials_stage_publishes_statements_artifact(tmp_path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    market_result = MarketSnapshotStage(artifacts, _CountingService()).run(_context())
    service = YFinanceResearchService(
        financials_loader=lambda ticker: {
            "incomeStatement": [{"index": "Total Revenue", "2026-01-31": 100.0}]
        }
    )
    stage = FinancialsArtifactStage(artifacts, service)
    result = stage.run(_context(market_result.artifacts[0].artifact_id))

    assert result.artifacts[0].key == "research/financials.json"
    payload = artifacts.get_json(result.artifacts[0].artifact_id).payload
    assert payload["rows"][0]["financials"]["incomeStatement"][0]["index"] == "Total Revenue"
