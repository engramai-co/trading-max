from __future__ import annotations

import csv
import json
import time
from datetime import UTC, date
from functools import partial
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from starlette.testclient import TestClient
from trading_max.application.decision_stages import AccountDecisionStage
from trading_max.application.nav_stages import AccountNavStage
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


@pytest.fixture
def synthetic_decision_market_data(monkeypatch: pytest.MonkeyPatch) -> None:
    def history(symbol: str, start: date, end: date) -> pd.DataFrame:
        close = 1.25 if symbol == "GBPUSD=X" else 100.0
        return pd.DataFrame({"Close": close}, index=pd.date_range(start, end, freq="B"))

    monkeypatch.setattr(
        "trading_max.application.runtime.AccountDecisionStage",
        partial(AccountDecisionStage, history_loader=history, events_loader=lambda _symbol: []),
    )


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


def _write_snapshot(
    root: Path, profile: str, total: str, *, pending_pie_cash: bool = False
) -> None:
    path = root / "trading212" / profile / "snapshots" / "snapshot_20260807.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "fetched_at_utc": "2026-08-07T20:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": "610" if pending_pie_cash else total,
                    "cash": (
                        {"availableToTrade": "10", "reservedForOrders": "0", "inPies": "500"}
                        if pending_pie_cash
                        else {"availableToTrade": "0"}
                    ),
                    "investments": {
                        "currentValue": "600" if pending_pie_cash else total,
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


def _seed_nav_snapshot(root: Path, codes=("A", "B")) -> None:
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
        for code in codes
    ]
    SnapshotStore(root).publish(scope="accounts", source="fixture", artifacts=refs)


def _seed_ledger(root: Path, profiles=("invest", "isa")) -> None:
    for profile in profiles:
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


@pytest.mark.parametrize("profiles", [("invest",), ("isa",), ("invest", "isa")])
def test_typed_manager_runs_accounts_without_legacy_pipeline(
    tmp_path: Path, profiles, synthetic_decision_market_data
) -> None:
    for profile in profiles:
        _write_snapshot(tmp_path, profile, "100")
    codes = tuple("A" if profile == "invest" else "B" for profile in profiles)
    _seed_nav_snapshot(tmp_path, codes)
    _seed_ledger(tmp_path, profiles)
    _seed_security_master(tmp_path)
    store = ArtifactStore(tmp_path)
    manager = TypedJobManager(
        store,
        WatchlistStore(tmp_path),
        embedded_worker=True,
        worker_poll_seconds=0.01,
        broker_profiles_loader=lambda: profiles,
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
        artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
        by_key = {ref.key: ref for ref in SnapshotStore(tmp_path).latest().manifest.artifacts}
        metrics = artifacts.get_json(
            by_key["account/broker_snapshot_metrics.json"].artifact_id
        ).payload
        assert set(metrics["accounts"]) == set(codes)
        history = artifacts.get_json(
            by_key["account/nav/valuation_history.json"].artifact_id
        ).payload
        latest_point = history["points"][-1]
        assert latest_point["total_value_gbp"] == 100 * len(profiles)
        for profile in ("invest", "isa"):
            assert (latest_point[f"{profile}_value_gbp"] is None) == (profile not in profiles)
            assert (f"account/{profile}.json" in by_key) == (profile in profiles)
        # Acceptance includes public reads, not just a successful publication.
        # In particular, balance confirmation must work without the other account.
        with TestClient(create_app(Settings(data_root=tmp_path, llm_provider="fake"))) as client:
            for view in (
                "overview",
                "holdings-positions",
                "holdings-lookthrough",
                "analytics",
                "review",
                "account-analysis",
            ):
                response = client.get(
                    f"/v1/dashboard/lens/{view}?detail=summary&account={codes[0]}"
                )
                assert response.status_code == 200, response.text
                payload = response.json()
                if view == "overview":
                    assert {item["code"] for item in payload["accounts"]} == set(codes)
                    assert payload["totalValueGbp"] == 100 * len(profiles)
            response = client.get("/v1/dashboard/history?range=ALL&scope=total")
            assert response.status_code == 200, response.text
            assert response.json()["nav"]
            point = response.json()["nav"][-1]
            assert point["total"] == 100 * len(profiles)
            for profile in ("invest", "isa"):
                response = client.get(f"/v1/dashboard/history?range=ALL&scope={profile}")
                assert response.status_code == 200, response.text
                point = response.json()["nav"][-1]
                assert (point.get(profile) is None) == (profile not in profiles)
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
    assert names.index("accounts.snapshot") < names.index("accounts.intraday_nav")
    assert names.index("accounts.intraday_nav") < names.index("snapshot.publish")
    assert names.index("accounts.snapshot") < names.index("accounts.day_attribution")


def test_full_refresh_reconstructs_intraday_and_uses_current_market_benchmark() -> None:
    names = [name for name, _ in stage_plan("all", skip_sync=True)]
    assert names.index("accounts.snapshot") < names.index("accounts.intraday_nav")
    assert names.index("accounts.snapshot") < names.index("accounts.day_attribution")
    assert names.index("research.technical") < names.index("accounts.performance")
    assert names.index("accounts.performance") < names.index("accounts.review")


def test_intraday_job_is_account_only_and_cannot_skip_broker_sync() -> None:
    specs = stage_plan("intraday", skip_sync=False)
    assert [name for name, _label in specs] == [
        "broker.sync",
        "accounts.snapshot",
        "accounts.intraday_nav",
        "accounts.day_attribution",
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


def test_performance_refresh_reconciles_pending_pie_cash_and_replays_retained_nav(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def history(symbol: str, start: date, end: date) -> pd.DataFrame:
        prices = {"GBPUSD=X": 1.25, "BE": 125.0}
        if symbol not in prices:
            return pd.DataFrame()
        return pd.DataFrame({"Close": prices[symbol]}, index=pd.bdate_range(start, end))

    monkeypatch.setattr(
        "trading_max.application.runtime.AccountNavStage",
        partial(AccountNavStage, history_loader=history),
    )
    _write_snapshot(tmp_path, "isa", "100", pending_pie_cash=True)
    _seed_ledger(tmp_path, ("isa",))
    (tmp_path / "trading212/isa/exports/latest.csv").write_text(
        "ID,Action,Time (UTC),ISIN,Ticker,No. of shares,Price / share,Currency (Price / share),Total\n"
        "1,Deposit,2026-08-03T08:00:00Z,,,,,,110\n"
        "2,Market buy,2026-08-03T15:00:00Z,US0937121079,BE,1,125,USD,100\n"
        "3,Deposit,2026-08-07T09:00:00Z,,,,,,500\n",
        encoding="utf-8",
    )
    store = ArtifactStore(tmp_path)
    retained = store.immutable_artifacts.put_bytes(
        key="account/nav/daily_nav_b.csv",
        content=(
            b"Date,SyntheticNAVGBP,CashGBP,MarketValueGBP,ValuationSource,ObservedAt,PerformanceStatus\n"
            b"2026-08-04,110,10.03,100,broker_native,2026-08-04T20:00:00Z,eligible\n"
        ),
        kind="nav_series",
        media_type="text/csv",
        producer_version=AccountNavStage.version,
    )
    store.immutable_snapshots.publish(scope="accounts", source="fixture", artifacts=[retained])
    manager = TypedJobManager(
        store,
        WatchlistStore(tmp_path),
        broker_profiles_loader=lambda: ("isa",),
    )
    try:
        queued = manager.submit("performance", skip_sync=True, trigger="performance")
        worker = manager._build_worker(worker_id="test", lease_seconds=90)
        assert worker.run_once()
        completed = manager.get(queued.job_id)
        assert completed.status.value == "succeeded", completed.error
        assert completed.snapshot_run_id
        account = store.read_json(completed.snapshot_run_id, "account/isa.json")
        assert account["fetched_at"].startswith("2026-08-07T20:00:00")
        assert account["pie_cash_in_investments_gbp"] == "500"
        assert account["checks"]["positions_match_investments"] is True

        latest = store.immutable_snapshots.latest()
        assert latest is not None
        nav_ref = next(
            ref for ref in latest.manifest.artifacts if ref.key == "account/nav/daily_nav_b.csv"
        )
        with store.immutable_artifacts.get_bytes(nav_ref.artifact_id).path.open() as nav:
            rows = {row["Date"]: row for row in csv.DictReader(nav)}
        assert rows["2026-08-04"]["ValuationSource"] == "broker_native"
        assert float(rows["2026-08-04"]["SyntheticNAVGBP"]) == 110
        assert float(rows["2026-08-04"]["CashGBP"]) == 10
        current = rows["2026-08-07"]
        assert float(current["SyntheticNAVGBP"]) == 610
        assert float(current["CashGBP"]) == 510
        assert float(current["MarketValueGBP"]) == 100
        assert float(current["ExternalFlowGBP"]) == 500
        assert current["PerformanceStatus"] == "eligible"
        performance = store.read_json(completed.snapshot_run_id, "account/performance_b.json")
        assert performance["twr_total_return"] == pytest.approx(0.0)
    finally:
        manager.close()


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


def test_every_registered_account_stage_is_planned_for_its_scopes(tmp_path: Path) -> None:
    """A stage registered for a scope must run there; registration alone runs nothing."""

    manager = TypedJobManager(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    try:
        registry = manager.registry
        for scope in ("intraday", "accounts", "all"):
            planned = {name for name, _label in stage_plan(scope, skip_sync=False)}
            missing = [
                name
                for name in registry.names()
                if scope in registry.get(name).required_for and name not in planned
            ]
            assert missing == [], f"{scope} plan omits {missing}"
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
            "DXYZ",
        ]
        assert watchlist.tickers() == queued.tickers[:-1]
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
    synthetic_decision_market_data,
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


def test_api_typed_runtime_admits_refresh_without_legacy_root(
    tmp_path: Path, synthetic_decision_market_data
) -> None:
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


def test_held_fund_refresh_publishes_scored_technical_rows_without_equity_data(
    tmp_path, seed_watchlist, monkeypatch
):
    from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY
    from trading_max.research.held_funds import (
        BROKER_SNAPSHOT_KEY,
        FUND_PRICES_KEY,
        LOOKTHROUGH_KEY,
    )

    store = ArtifactStore(tmp_path)
    watchlist = WatchlistStore(tmp_path)
    seed_watchlist(watchlist, "BE")
    position = {
        "ticker": "SYNFUND",
        "broker_ticker": "SYNFUNDl_EQ",
        "isin": "IE0000000001",
        "current_value_gbp": 100,
        "price_currency": "GBP",
    }
    monkeypatch.setattr(
        "trading_max.application.etf_depth_stage.HMRCReportingSource.refresh",
        lambda *_: None,
    )
    payloads = {
        BROKER_SNAPSHOT_KEY: {
            "accounts": {"A": {"positions": [position]}, "B": {"positions": [position]}}
        },
        "account/synthetic_nav_metrics.json": {"A": {}, "B": {}},
        "account/policy_metrics.json": {},
        "research/technical.json": {
            "tickers": ["BE"],
            "rows": [{"ticker": "BE", "technical_score": 65}],
        },
        LOOKTHROUGH_KEY: {"fundPositions": [{"ticker": "SYNFUND", "isin": position["isin"]}]},
        ETF_SUMMARY_KEY: {
            "funds": [
                {
                    "isin": position["isin"],
                    "tickers": ["SYNFUND"],
                    "holdingsState": "no-holdings",
                    "tracking": {"state": "missing"},
                    "overlap": {"state": "missing"},
                }
            ]
        },
    }
    store.immutable_snapshots.publish(
        scope="accounts",
        source="fixture",
        artifacts=[
            store.immutable_artifacts.put_json(
                key=key, payload=payload, kind="fixture", producer_version="fixture"
            )
            for key, payload in payloads.items()
        ]
        + [
            store.immutable_artifacts.put_bytes(
                key=f"account/nav/daily_nav_{code}.csv",
                content=b"Date,SyntheticNAVGBP\n2026-11-11,100\n",
                kind="fixture",
                media_type="text/csv",
            )
            for code in ("a", "b")
        ],
    )
    histories, options, adr = [], [], []

    def history(ticker, period):
        histories.append(ticker)
        return _research_history(ticker, period)

    def options_loader(ticker, *args):
        options.append(ticker)
        return _research_options_unavailable(ticker, *args)

    def adr_loader(ticker, *_):
        adr.append(ticker)

    def forbidden(*args, **kwargs):
        pytest.fail("fund refresh requested equity provider data")

    research = YFinanceResearchService(info_loader=forbidden)
    research.fundamentals = research.financials = research.analyst = research.earnings = forbidden
    manager = TypedJobManager(
        store,
        watchlist,
        market_service=MarketResearchService(
            history_loader=history, options_loader=options_loader, adr_loader=adr_loader
        ),
        research_service=research,
    )
    try:
        queued = manager.submit("research", skip_sync=True)
        assert queued.tickers == ["BE", "SYNFUND.L"]
        manager.cancel(queued.job_id)
        queued = manager.submit("research", skip_sync=True, tickers=["SYNFUND.L"])
        assert manager._build_worker(worker_id="fixture", lease_seconds=60).run_once()
        assert manager.get(queued.job_id).status.value == "succeeded"
        assert sorted(histories) == sorted(
            ["SPY", "QQQ", "SOXX", "GBPUSD=X", "VOO", "VT", "SYNFUND.L"]
        )
        assert options == adr == []
        latest = store.latest_manifest()
        result = store.read_json(latest.run_id, FUND_PRICES_KEY)["rows"][0]
        assert (result["ticker"], result["isin"], result["mic"]) == (
            "SYNFUND.L",
            position["isin"],
            "XLON",
        )
        assert result["price_series"]
        technical_rows = {
            row["ticker"]: row
            for row in store.read_json(latest.run_id, "research/technical.json")["rows"]
        }
        assert technical_rows["BE"]["technical_score"] == 65
        technical = technical_rows["SYNFUND.L"]
        assert technical["asset_type"] == "ETF"
        assert technical["technical_score"] is not None
        assert technical["price_series"] == result["price_series"]
        from services.api.trading_max_api.analysis_context import AnalysisContextBuilder
        from services.api.trading_max_api.dashboard import build_dashboard_data
        from services.api.trading_max_api.research import ResearchLedger

        dashboard = build_dashboard_data(store, latest)
        assert dashboard["holdings"][0]["researchTicker"] == "SYNFUND.L"
        score = next(row["score"] for row in dashboard["technical"] if row["ticker"] == "SYNFUND.L")
        assert score == technical["technical_score"]
        assert dashboard["options"] == []
        ledger = ResearchLedger(store, watchlist)
        lens = ledger.lens_snapshot("SYNFUND", "technical", latest, detail="summary")
        assert lens.ticker == "SYNFUND.L"
        assert lens.technical.score == score
        assert lens.technical.score_explanation_state == "verified"
        assert lens.technical.score_breakdown.score == score
        summary = ledger.lens_snapshot("SYNFUND.L", "overview", latest, detail="summary")
        assert summary.technical is None
        assert summary.technical_summary.score == score
        assert ledger.timeline("SYNFUND")[0].technical["score"] == score
        context = AnalysisContextBuilder(store, watchlist).build(
            latest, "technical_regime", "SYNFUND.L"
        )
        assert context["selected"]["technical"]["score"] == score
        assert context["selected"]["valuation"] is None
        assert store.read_json(latest.run_id, ETF_SUMMARY_KEY) == payloads[ETF_SUMMARY_KEY]
        assert not any(
            ref.key
            in {"research/valuation.json", "research/analyst.json", "research/financials.json"}
            for ref in latest.artifacts
        )
    finally:
        manager.close()


def test_held_ucits_and_us_etfs_publish_independent_option_rows(
    tmp_path, seed_watchlist, monkeypatch
):
    from datetime import datetime, timedelta

    from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY
    from trading_max.infrastructure.sector_prices import SparkSeries, YahooSparkPrices
    from trading_max.infrastructure.shared_market_prices import SharedMarketPrices
    from trading_max.research.held_funds import BROKER_SNAPSHOT_KEY, LOOKTHROUGH_KEY
    from trading_max.research.technical import OptionsResearchArtifact

    monkeypatch.setattr(
        "trading_max.application.etf_depth_stage.HMRCReportingSource.refresh",
        lambda *_: None,
    )
    store = ArtifactStore(tmp_path)
    watchlist = WatchlistStore(tmp_path)
    seed_watchlist(watchlist, "BE")
    positions = [
        {"ticker": ticker, "broker_ticker": listing, "isin": isin, "current_value_gbp": 20}
        for ticker, listing, isin in (
            ("EQGB", "EQGBl_EQ", "IE00BYVTMW98"),
            ("SMH", "SMHl_EQ", "IE00BMC38736"),
            ("SMH", "SMH_US_EQ", "US0000000001"),
        )
    ]
    payloads = {
        BROKER_SNAPSHOT_KEY: {
            "accounts": {"A": {"positions": positions}, "B": {"positions": positions}}
        },
        LOOKTHROUGH_KEY: {"fundPositions": positions},
        ETF_SUMMARY_KEY: {"funds": []},
        "research/options.json": {
            "tickers": ["BE"],
            "rows": [{"ticker": "BE", "spot": 20}],
            "generated_at": "2026-10-01T20:00:00Z",
        },
    }
    store.immutable_snapshots.publish(
        scope="accounts",
        source="fixture",
        artifacts=[
            store.immutable_artifacts.put_json(key=key, payload=payload)
            for key, payload in payloads.items()
        ],
    )
    marks, option_calls = [], []

    class FixtureQuotes(YahooSparkPrices):
        def daily(self, symbols):
            marks.append(list(symbols))
            return {
                ticker: SparkSeries(ticker, (1,), (float(100 + i),))
                for i, ticker in enumerate(symbols)
            }

    def options_loader(ticker, yf_ticker, spot):
        option_calls.append((ticker, spot))
        expiry = (date.today() + timedelta(days=7)).isoformat()
        return OptionsResearchArtifact(
            ticker=ticker,
            yf_ticker=yf_ticker,
            spot=spot,
            currency="USD",
            captured_at=datetime.now(UTC),
            expiry_count=1,
            expiry_range=[expiry],
            aggregate={},
            gamma_proxy={},
            expiries=[{"expiry": expiry}],
            contracts=[{"expiry": expiry, "side": "call", "strike": 101, "currency": "USD"}],
        )

    def forbidden(*args, **kwargs):
        pytest.fail("ETF-only refresh requested company data")

    research = YFinanceResearchService(info_loader=forbidden)
    research.fundamentals = research.financials = research.analyst = research.earnings = forbidden
    manager = TypedJobManager(
        store,
        watchlist,
        market_service=MarketResearchService(
            history_loader=_research_history,
            options_loader=options_loader,
            adr_loader=forbidden,
            prices=SharedMarketPrices(FixtureQuotes()),
        ),
        research_service=research,
    )
    try:
        job = manager.submit("research", skip_sync=True, tickers=["EQGB.L", "SMH.L", "SMH"])
        assert manager._build_worker(worker_id="fixture", lease_seconds=60).run_once()
        assert manager.get(job.job_id).status.value == "succeeded"
        assert marks == [["QQQ", "QQQM", "SMH"]]
        assert option_calls == [("QQQ", 100.0), ("QQQM", 101.0), ("SMH", 102.0)]
        latest = store.latest_manifest()
        chains = store.read_json(latest.run_id, "research/options.json")
        assert [row["ticker"] for row in chains["rows"]] == ["BE", "QQQ", "QQQM", "SMH"]
        assert chains["rowClocks"]["BE"]["fetchedAt"] == "2026-10-01T20:00:00Z"
        technical = {
            row["ticker"]: row
            for row in store.read_json(latest.run_id, "research/technical.json")["rows"]
        }
        for ticker in ("EQGB.L", "SMH.L", "SMH"):
            assert technical[ticker]["technical_score"] is not None
        assert "QQQM" not in technical  # A reference alone requests options only.
        assert not any(ref.key == "research/fundamentals.json" for ref in latest.artifacts)
        from trading_max.application.stages import StageContext

        stage = manager.registry.get("market.snapshot")
        result = stage.run(
            StageContext(
                job_id="synthetic-research-slot",
                scope="research",
                trigger="research",
                tickers=("EQGB.L",),
            )
        )
        scheduled = store.immutable_artifacts.get_json(result.artifacts[0].artifact_id).payload
        assert scheduled["options"]["tickers"] == []
        assert {row["ticker"] for row in scheduled["technical"]["rows"]} >= {
            "EQGB.L",
            "SMH.L",
            "SMH",
        }
        assert len(option_calls) == 3
        latest = store.latest_manifest()
        assert store.read_json(latest.run_id, "research/options.json") == chains
    finally:
        manager.close()
