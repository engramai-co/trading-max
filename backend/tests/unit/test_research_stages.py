from __future__ import annotations

from datetime import UTC
from types import SimpleNamespace

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
    FundPriceStage,
    MarketSnapshotStage,
    OptionsArtifactStage,
    TechnicalArtifactStage,
    TypedPublishSnapshotStage,
    ValuationArtifactStage,
)
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.held_funds import FUND_PRICE_DIRECTORY_KEY, FUND_PRICES_KEY
from trading_max.research.market import MarketResearchService
from trading_max.worker import StageExecutionError
from yfinance._http import HTTPError
from yfinance.data import YfData
from yfinance.exceptions import YFException


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
        "monthly_observations": 33,
        "excludes_incomplete_month": True,
    }
    assert set(technical_payload["benchmark_series"]) == {"VOO", "QQQ", "VT"}
    assert len(technical_payload["benchmark_series"]["VOO"]) == 760
    assert technical_payload["benchmark_currency"] == "GBP"
    assert technical_payload["benchmark_return_basis"] == "auto_adjusted_close"
    assert options_result.artifacts[0].key == "research/options.json"
    assert adr_result.artifacts[0].key == "research/adr.json"
    assert technical_result.artifacts[0].dependency_artifact_ids == [market_ref.artifact_id]
    assert options_result.artifacts[0].dependency_artifact_ids == [market_ref.artifact_id]


@pytest.mark.parametrize(
    ("as_of", "points", "previous_close"),
    [
        (
            "2026-11-13",
            [{"date": "2026-11-12", "close": 100.0}, {"date": "2026-11-13", "close": 96.0}],
            100.0,
        ),
        ("2026-11-13", [{"date": "2026-11-13", "close": 96.0}], None),
        (
            "2026-11-12",
            [{"date": "2026-11-12", "close": 100.0}, {"date": "2026-11-13", "close": 96.0}],
            None,
        ),
    ],
)
def test_fund_price_stage_publishes_previous_close_with_the_matching_spot(
    tmp_path, as_of, points, previous_close
):
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    source = artifacts.put_json(
        key="research/market_snapshot.json",
        payload={
            "fund_listings": {"TEST.L": {"mic": "XLON"}},
            "technical": {
                "rows": [
                    {
                        "ticker": "TEST.L",
                        "as_of": as_of,
                        "price": 96.0,
                        "currency": "GBP",
                        "exchange": "LSE",
                        "timezone": "Europe/London",
                        "price_series": points,
                    }
                ]
            },
        },
        kind="market-snapshot",
    )
    price_ref, directory_ref = (
        FundPriceStage(artifacts).run(_context(source.ref.artifact_id)).artifacts
    )
    assert price_ref.key == FUND_PRICES_KEY
    assert directory_ref.key == FUND_PRICE_DIRECTORY_KEY
    row = artifacts.get_json(price_ref.artifact_id).payload["rows"][0]
    published = artifacts.get_json(directory_ref.artifact_id).payload["rows"][0]
    assert row["price_series"] == points
    assert published == {
        "ticker": "TEST.L",
        "mic": "XLON",
        "as_of": as_of,
        "spot": 96.0,
        "currency": "GBP",
        "exchange": "LSE",
        "timezone": "Europe/London",
        "previous_close": previous_close,
    }
    assert row["previous_close"] == previous_close


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


@pytest.mark.parametrize(
    ("provider_failure", "reason"),
    [
        ("http404", "provider-not-found"),
        ("empty", "provider-no-data"),
        ("wrapped404", "provider-not-found"),
    ],
)
def test_yahoo_fundamentals_gap_publishes_missing_coverage(
    tmp_path, monkeypatch, provider_failure, reason
):
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)
    endpoints = []

    def get_raw_json(_self, url, *, params):
        symbol = params.get("symbol") or params["symbols"]
        endpoints.append((url, symbol))
        if symbol == "GOOG":
            return {"quoteResponse": {"result": [{"symbol": "GOOG", "forwardPE": 12.0}]}}
        if provider_failure == "empty" and "/quoteSummary/" in url:
            raise HTTPError(
                "synthetic quoteSummary 404",
                response=SimpleNamespace(status_code=404, text="not found"),
            )
        return {}

    def cache_get(_self, *, url):
        endpoints.append((url, None))
        if provider_failure == "http404":
            raise HTTPError("synthetic provider 404", response=SimpleNamespace(status_code=404))
        if provider_failure == "wrapped404":
            return SimpleNamespace(
                text='{"finance":{"error":{"code":"Not Found","description":"synthetic"}}}'
            )
        return SimpleNamespace(text='{"timeseries":{"result":[]}}')

    monkeypatch.setattr(YfData, "get_raw_json", get_raw_json)
    monkeypatch.setattr(YfData, "cache_get", cache_get)
    service = YFinanceResearchService()
    stage = FundamentalsArtifactStage(artifacts, service)
    if provider_failure == "empty":
        # Both share classes must keep their own provider symbol and result.
        mixed = service.fundamentals(["GOOG", " googl "])
        assert [(row["ticker"], row["metrics"]["forwardPE"]) for row in mixed.rows] == [
            ("GOOG", 12.0),
        ]
        assert mixed.missing == {"GOOGL": reason}
        endpoints.clear()

    result = stage.run(StageContext(job_id="404", scope="research", tickers=("GOOGL",)))
    ref = result.artifacts[0]
    assert ref.quality.coverage == "0/1"
    assert ref.quality.status == "warning"
    assert artifacts.get_json(ref.artifact_id).payload["rows"] == []
    TypedPublishSnapshotStage(artifacts, snapshots).run(
        StageContext(
            job_id="404",
            scope="research",
            tickers=("GOOGL",),
            upstream_artifact_ids=(ref.artifact_id,),
        )
    )
    coverage = next(
        r for r in snapshots.latest().manifest.artifacts if r.key == "research/coverage.json"
    )
    row = artifacts.get_json(coverage.artifact_id).payload["rows"][0]
    assert row["ticker"] == "GOOGL"
    assert row["datasets"]["fundamentals"]["state"] == "missing"
    assert row["datasets"]["fundamentals"]["reason"] == reason
    assert endpoints[0] == (
        "https://query2.finance.yahoo.com/v10/finance/quoteSummary/GOOGL",
        "GOOGL",
    )
    assert endpoints[1][1] == "GOOGL"
    assert "/timeseries/GOOGL?" in endpoints[2][0]


def test_unavailable_fundamentals_transport_still_fails_refresh(tmp_path):
    def load(_ticker):
        raise YFException("synthetic upstream failure")

    stage = FundamentalsArtifactStage(
        ContentAddressedArtifactStore(tmp_path / "artifacts"),
        YFinanceResearchService(info_loader=load),
    )
    with pytest.raises(StageExecutionError, match="no usable rows") as caught:
        stage.run(_context())
    assert caught.value.retryable


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
