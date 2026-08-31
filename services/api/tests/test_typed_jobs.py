from __future__ import annotations

import json
import time
from datetime import UTC, date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.reference import (
    SecurityEntityRecord,
    SecurityMasterCatalog,
    classification_for_code,
)
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.market import MarketResearchService

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.typed_jobs import (
    TypedJobManager,
    _structural_projection,
    stage_plan,
)
from services.api.trading_max_api.valuation_assumptions import (
    ValuationAssumptionsStore,
)
from services.api.trading_max_api.watchlist import WatchlistStore


def _research_history(ticker: str, _period: str) -> pd.DataFrame:
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


def _research_options_unavailable(
    _ticker: str,
    _yf_ticker: str,
    _spot: float,
):
    raise RuntimeError("fixture has no option chain")


def _write_snapshot(root: Path, profile: str, total: str) -> None:
    path = root / "trading212" / profile / "snapshots" / "snapshot_20260807.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "fetched_at_utc": "2026-08-07T20:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": total,
                    "cash": {"availableToTrade": "0"},
                    "investments": {
                        "currentValue": total,
                        "totalCost": "90",
                        "realizedProfitLoss": "1",
                        "unrealizedProfitLoss": "9",
                    },
                },
                "positions": [
                    {
                        "instrument": {
                            "ticker": "BE_US_EQ",
                            "name": "Bloom Energy",
                            "isin": "US0937121079",
                            "currency": "USD",
                        },
                        "quantity": "1",
                        "currentPrice": "100",
                        "walletImpact": {
                            "currentValue": total,
                            "totalCost": "90",
                            "unrealizedProfitLoss": "9",
                            "fxImpact": "0",
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def _seed_nav_snapshot(root: Path) -> None:
    artifacts = ContentAddressedArtifactStore(root / "artifacts")
    nav = (
        b"Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP\n"
        b"2026-08-01,100,0,0\n"
        b"2026-08-02,101,0,0\n"
    )
    refs = [
        artifacts.put_bytes(
            key=f"account/nav/daily_nav_{code.lower()}.csv",
            content=nav,
            kind="nav_series",
            media_type="text/csv",
            producer_version="fixture-v1",
        )
        for code in ("A", "B")
    ]
    SnapshotStore(root).publish(scope="accounts", source="fixture", artifacts=refs)


def _seed_ledger(root: Path) -> None:
    for profile in ("invest", "isa"):
        account_root = root / "trading212" / profile
        exports = account_root / "exports"
        exports.mkdir(parents=True)
        (exports / "latest.csv").write_text(
            "ID,Action,Time (UTC),Ticker,Name,No. of shares,Price / share,Total,"
            "Currency conversion fee,Result\n"
            "1,Market buy,2026-08-01T10:00:00Z,BE,Bloom Energy,1,10,10,0,\n",
            encoding="utf-8",
        )
        (account_root / "latest_export.json").write_text(
            '{"profile":"' + profile + '","csv":{"path":"' + profile + '/exports/latest.csv"}}',
            encoding="utf-8",
        )


def _seed_security_master(root: Path) -> None:
    path = root / "reference" / "security-master.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        SecurityMasterCatalog(
            as_of=date.today().isoformat(),
            records=[
                SecurityEntityRecord(
                    entity_id="isin:US0937121079",
                    canonical_ticker="BE",
                    entity_name="Bloom Energy Corporation",
                    security_type="EQUITY",
                    provider_security_type="Common Stock",
                    market_sector="Equity",
                    gics_eligibility="eligible",
                    ticker_aliases=["BE", "BE_US_EQ"],
                    name_aliases=["Bloom Energy", "Bloom Energy Corporation"],
                    isins=["US0937121079"],
                    profile_sector="Industrials",
                    profile_industry="Electrical Equipment & Parts",
                    gics=classification_for_code(
                        "20104010",
                        source="test-fixture",
                        as_of=date.today().isoformat(),
                    ),
                    source="test-fixture",
                    as_of=date.today().isoformat(),
                )
            ],
        ).model_dump_json(by_alias=True),
        encoding="utf-8",
    )


def test_typed_manager_runs_accounts_without_legacy_pipeline(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    _seed_nav_snapshot(tmp_path)
    _seed_ledger(tmp_path)
    _seed_security_master(tmp_path)
    store = ArtifactStore(tmp_path)
    manager = TypedJobManager(
        store,
        WatchlistStore(tmp_path),
        embedded_worker=True,
        worker_poll_seconds=0.01,
    )
    try:
        queued = manager.submit("accounts", skip_sync=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = manager.get(queued.job_id)
            if current.status.value in {"succeeded", "failed", "interrupted"}:
                break
            time.sleep(0.01)
        completed = manager.get(queued.job_id)
        assert completed.status.value == "succeeded"
        assert completed.snapshot_run_id
        latest = store.latest_manifest()
        assert latest is not None
        assert latest.run_id == completed.snapshot_run_id
        assert "account/broker_snapshot_metrics.json" in {
            artifact.key for artifact in latest.artifacts
        }
    finally:
        manager.close()


def test_typed_account_job_declares_nav_before_performance() -> None:
    names = [
        name
        for name, _label in stage_plan(
            "accounts",
            skip_sync=True,
        )
    ]

    assert names.index("accounts.snapshot") < names.index("accounts.nav")
    assert names.index("accounts.snapshot") < names.index("reference.security_master")
    assert names.index("reference.security_master") < names.index("portfolio.lookthrough")
    assert names.index("accounts.snapshot") < names.index("portfolio.lookthrough")
    assert names.index("accounts.nav") < names.index("accounts.performance")


def test_intraday_job_is_account_only_and_cannot_skip_broker_sync() -> None:
    specs = stage_plan("intraday", skip_sync=False)
    assert [name for name, _label in specs] == [
        "broker.sync",
        "accounts.snapshot",
        "accounts.intraday_nav",
        "snapshot.publish",
    ]
    with pytest.raises(ValueError, match="cannot skip broker sync"):
        stage_plan("intraday", skip_sync=True)


def test_canonical_live_scope_preserves_lightweight_intraday_boundary() -> None:
    assert stage_plan("live", skip_sync=False) == stage_plan("intraday", skip_sync=False)


def test_performance_scope_is_lightweight_and_never_syncs_history() -> None:
    assert stage_plan("performance", skip_sync=True) == [
        ("accounts.snapshot", "Normalize accounts"),
        ("accounts.nav", "Update account NAV"),
        ("accounts.performance", "Calculate account performance"),
        ("snapshot.publish", "Publish immutable snapshot"),
    ]
    with pytest.raises(ValueError, match="latest live broker snapshot"):
        stage_plan("performance", skip_sync=False)


def test_research_scope_refreshes_lookthrough_without_broker_history() -> None:
    names = [
        name
        for name, _label in stage_plan(
            "research",
            skip_sync=True,
            trigger="research",
        )
    ]
    assert "broker.sync" not in names
    assert names.index("accounts.snapshot") < names.index("portfolio.lookthrough")
    assert names.index("reference.security_master") < names.index("portfolio.lookthrough")
    assert names.index("portfolio.lookthrough") < names.index("market.snapshot")


def test_structural_projection_ignores_prices_and_normalizes_numbers() -> None:
    canonical = {
        "accounts": {
            "A": {
                "cash_gbp": 200,
                "positions": [
                    {
                        "ticker": "BE",
                        "isin": "US0001",
                        "quantity": 5,
                        "total_cost_gbp": 900,
                        "current_price": 180,
                    }
                ],
            }
        }
    }
    live = {
        "accounts": {
            "A": {
                "cash_gbp": 200.0,
                "positions": [
                    {
                        "ticker": "be",
                        "isin": "US0001",
                        "quantity": 5.0,
                        "total_cost_gbp": 900.0,
                        "current_price": 220,
                    }
                ],
            }
        }
    }
    assert _structural_projection(live) == _structural_projection(canonical)
    live["accounts"]["A"]["positions"][0]["quantity"] = 6
    assert _structural_projection(live) != _structural_projection(canonical)


def test_cfd_job_isolated_from_broker_and_investable_account_stages() -> None:
    assert stage_plan("cfd", skip_sync=True) == [
        ("accounts.cfd", "Build imported CFD ledger and analysis"),
        ("snapshot.publish", "Publish immutable snapshot"),
    ]


def test_typed_manager_persists_cfd_job_scope(tmp_path: Path) -> None:
    manager = TypedJobManager(
        ArtifactStore(tmp_path),
        WatchlistStore(tmp_path),
    )
    try:
        queued = manager.submit("cfd", skip_sync=True)
        assert queued.scope == "cfd"
        assert [stage.name for stage in queued.stages] == [
            "accounts.cfd",
            "snapshot.publish",
        ]
        manager.cancel(queued.job_id)
    finally:
        manager.close()


def test_job_specs_bind_versions_from_the_executable_registry(tmp_path: Path) -> None:
    manager = TypedJobManager(
        ArtifactStore(tmp_path),
        WatchlistStore(tmp_path),
    )
    try:
        specs = manager._stage_specs("accounts", skip_sync=True)
        assert specs
        assert all(version == manager.registry.get(name).version for name, version, _label in specs)
    finally:
        manager.close()


def test_empty_watchlist_seeds_current_direct_equity_holdings(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    _seed_security_master(tmp_path)
    watchlist = WatchlistStore(tmp_path)
    manager = TypedJobManager(ArtifactStore(tmp_path), watchlist)
    try:
        queued = manager.submit("research", skip_sync=True)

        assert queued.tickers == ["BE"]
        assert [item.ticker for item in watchlist.items()] == ["BE"]
    finally:
        manager.close()


def test_empty_watchlist_classifies_holdings_before_first_security_master(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    watchlist = WatchlistStore(tmp_path)
    manager = TypedJobManager(
        ArtifactStore(tmp_path),
        watchlist,
        research_service=YFinanceResearchService(
            info_loader=lambda ticker: {
                "symbol": ticker,
                "longName": "Bloom Energy Corporation",
                "quoteType": "EQUITY",
                "exchange": "NYQ",
            }
        ),
    )
    try:
        queued = manager.submit("research", skip_sync=True)

        assert queued.tickers == ["BE"]
        assert [item.ticker for item in watchlist.items()] == ["BE"]
    finally:
        manager.close()


def test_empty_watchlist_uses_mag_seven_for_etf_only_portfolio(tmp_path: Path) -> None:
    for profile in ("invest", "isa"):
        path = tmp_path / "trading212" / profile / "snapshots" / "snapshot_20260807.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "fetched_at_utc": "2026-08-07T20:00:00Z",
                    "account_summary": {
                        "currency": "GBP",
                        "totalValue": "100",
                        "cash": {"availableToTrade": "0"},
                        "investments": {
                            "currentValue": "100",
                            "totalCost": "90",
                            "realizedProfitLoss": "1",
                            "unrealizedProfitLoss": "9",
                        },
                    },
                    "positions": [
                        {
                            "instrument": {
                                "ticker": "DXYZ_US_EQ",
                                "name": "Destiny Tech100",
                                "isin": "US25063F1075",
                                "currency": "USD",
                            },
                            "quantity": "1",
                            "currentPrice": "100",
                            "walletImpact": {
                                "currentValue": "100",
                                "totalCost": "90",
                                "unrealizedProfitLoss": "9",
                                "fxImpact": "0",
                            },
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
    security_master = tmp_path / "reference" / "security-master.json"
    security_master.parent.mkdir(parents=True)
    security_master.write_text(
        SecurityMasterCatalog(
            as_of=date.today().isoformat(),
            records=[
                SecurityEntityRecord(
                    entity_id="isin:US25063F1075",
                    canonical_ticker="DXYZ",
                    entity_name="Destiny Tech100 Inc.",
                    security_type="ETF",
                    provider_security_type="Exchange Traded Fund",
                    ticker_aliases=["DXYZ", "DXYZ_US_EQ"],
                    isins=["US25063F1075"],
                    gics_eligibility="not-applicable",
                    source="test-fixture",
                    as_of=date.today().isoformat(),
                )
            ],
        ).model_dump_json(by_alias=True),
        encoding="utf-8",
    )
    watchlist = WatchlistStore(tmp_path)
    manager = TypedJobManager(ArtifactStore(tmp_path), watchlist)
    try:
        queued = manager.submit("research", skip_sync=True)

        assert queued.tickers == [
            "AAPL",
            "MSFT",
            "AMZN",
            "GOOGL",
            "META",
            "NVDA",
            "TSLA",
        ]
        assert watchlist.tickers() == queued.tickers
    finally:
        manager.close()


def test_typed_research_job_declares_full_stage_dependencies() -> None:
    names = [
        name
        for name, _label in stage_plan(
            "research",
            skip_sync=True,
        )
    ]

    assert names.index("market.snapshot") < names.index("research.technical")
    assert names.index("market.snapshot") < names.index("research.taxonomy")
    assert names.index("research.technical") < names.index("research.options")
    assert names.index("research.technical") < names.index("research.adr")
    assert names.index("research.fundamentals") < names.index("research.valuation")
    assert names.index("research.technical") < names.index("research.valuation")
    assert names.index("research.fundamentals") < names.index("research.earnings")


def test_typed_research_job_declares_market_dependencies() -> None:
    names = [
        name
        for name, _label in stage_plan(
            "research",
            skip_sync=True,
        )
    ]

    assert names.index("market.snapshot") < names.index("research.technical")
    assert names.index("research.technical") < names.index("research.options")
    assert names.index("research.technical") < names.index("research.adr")


def test_typed_manager_cancels_a_queued_job(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path)
    manager = TypedJobManager(store, WatchlistStore(tmp_path))
    try:
        queued = manager.submit("research", skip_sync=True, tickers=["BE"])
        cancelled = manager.cancel(queued.job_id)
        assert cancelled.status.value == "interrupted"
        assert cancelled.error == "cancelled by operator"
    finally:
        manager.close()


def test_typed_research_job_runs_all_research_artifacts_with_injected_providers(
    tmp_path: Path,
    seed_watchlist,
) -> None:
    market_service = MarketResearchService(
        history_loader=_research_history,
        options_loader=_research_options_unavailable,
        adr_loader=lambda _ticker, _frame, _period: None,
    )
    research_service = YFinanceResearchService(
        info_loader=lambda ticker: {
            "longName": f"{ticker} fixture",
            "currency": "USD",
            "forwardPE": 18.5,
        },
        calendar_loader=lambda _ticker: {"Earnings Date": "2026-09-01"},
        analyst_loader=lambda _ticker: {"priceTargets": {"mean": 120.0}},
        financials_loader=lambda _ticker: {"incomeStatement": []},
    )
    store = ArtifactStore(tmp_path)
    watchlist_store = WatchlistStore(tmp_path)
    seed_watchlist(watchlist_store, "BE", "TSM")
    assumptions_store = ValuationAssumptionsStore(tmp_path)
    manager = TypedJobManager(
        store,
        watchlist_store,
        valuation_assumptions=assumptions_store,
        embedded_worker=True,
        worker_poll_seconds=0.01,
        market_service=market_service,
        research_service=research_service,
    )
    try:
        queued = manager.submit(
            "research",
            skip_sync=True,
            tickers=["BE", "TSM"],
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = manager.get(queued.job_id)
            if current.status.value in {"succeeded", "failed", "interrupted"}:
                break
            time.sleep(0.01)
        completed = manager.get(queued.job_id)
        assert completed.status.value == "succeeded"
        latest = store.latest_manifest()
        assert latest is not None
        assert latest.run_id == completed.snapshot_run_id
        assert {
            "research/market_snapshot.json",
            "research/taxonomy.json",
            "research/technical.json",
            "research/options.json",
            "research/adr.json",
            "research/fundamentals.json",
            "research/analyst.json",
            "research/financials.json",
            "research/valuation.json",
            "research/valuation_assumptions.json",
            "research/earnings.json",
        } <= {artifact.key for artifact in latest.artifacts}
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            be_status = next(
                item.status for item in watchlist_store.load().items if item.ticker == "BE"
            )
            if be_status == "ready":
                break
            time.sleep(0.01)
        assert be_status == "ready"
    finally:
        manager.close()


def test_full_refresh_reconciles_bootstrapped_watchlist_status(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    _seed_nav_snapshot(tmp_path)
    _seed_ledger(tmp_path)
    _seed_security_master(tmp_path)
    market_service = MarketResearchService(
        history_loader=_research_history,
        options_loader=_research_options_unavailable,
        adr_loader=lambda _ticker, _frame, _period: None,
    )
    research_service = YFinanceResearchService(
        info_loader=lambda ticker: {
            "longName": f"{ticker} fixture",
            "currency": "USD",
            "forwardPE": 18.5,
        },
        calendar_loader=lambda _ticker: {"Earnings Date": "2026-09-01"},
        analyst_loader=lambda _ticker: {"priceTargets": {"mean": 120.0}},
        financials_loader=lambda _ticker: {"incomeStatement": []},
    )
    store = ArtifactStore(tmp_path)
    watchlist_store = WatchlistStore(tmp_path)
    manager = TypedJobManager(
        store,
        watchlist_store,
        embedded_worker=True,
        worker_poll_seconds=0.01,
        market_service=market_service,
        research_service=research_service,
    )
    try:
        queued = manager.submit("all", skip_sync=True)
        assert queued.tickers == ["BE"]

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = manager.get(queued.job_id)
            if current.status.value in {"succeeded", "failed", "interrupted"}:
                break
            time.sleep(0.01)

        completed = manager.get(queued.job_id)
        assert completed.status.value == "succeeded"
        reconcile_deadline = time.monotonic() + 3
        while time.monotonic() < reconcile_deadline:
            item = next(item for item in watchlist_store.items() if item.ticker == "BE")
            if item.status == "ready":
                break
            time.sleep(0.01)
        assert item.status == "ready"
        assert item.last_run_id == completed.snapshot_run_id
    finally:
        manager.close()


def test_api_typed_runtime_admits_refresh_without_legacy_root(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "invest", "100")
    _write_snapshot(tmp_path, "isa", "100")
    _seed_nav_snapshot(tmp_path)
    _seed_ledger(tmp_path)
    _seed_security_master(tmp_path)
    app = create_app(
        Settings(
            data_root=tmp_path,
            api_token="secret",
            embedded_worker=True,
            llm_provider="fake",
        )
    )
    from starlette.testclient import TestClient

    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs/refresh",
            headers={"Authorization": "Bearer secret"},
            json={"scope": "accounts", "skipSync": True},
        )
        assert response.status_code == 202
        job_id = response.json()["jobId"]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = client.get(f"/v1/jobs/{job_id}").json()
            if current["status"] in {"succeeded", "failed", "interrupted"}:
                break
            time.sleep(0.01)
        assert client.get(f"/v1/jobs/{job_id}").json()["status"] == "succeeded"
