from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from services.api.trading_max_api import app as app_module
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.models import SecuritySearchResult
from services.api.trading_max_api.provider_runtime import ProviderRuntimeError
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.typed_analysis import TypedAnalysisManager
from services.api.trading_max_api.watchlist import WatchlistStore


def _fixture_watchlist(data_root: Path) -> WatchlistStore:
    watchlist = WatchlistStore(data_root)
    for ticker, name, figi in (
        ("BE", "Bloom Energy Corp", "BBG001BBH6X2"),
        ("NVDA", "NVIDIA Corp", "BBG000BBJQV0"),
    ):
        watchlist.add(
            SecuritySearchResult(
                ticker=ticker,
                name=name,
                exchange="NASDAQ" if ticker == "NVDA" else "NYSE",
                bloomberg_ticker=f"{ticker} US Equity",
                figi=figi,
            )
        )
    return watchlist


def test_api_bootstraps_and_serves_dashboard(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    _fixture_watchlist(tmp_path / "runtime")
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        )
    )
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert health.json()["worker"]["healthy"] is True
        assert health.json()["queue"]["succeeded"] >= 0
        ready = client.get("/ready")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"
        assert client.get("/v1/dashboard").json()["totalValueGbp"] == 2000
        overview_lens = client.get("/v1/dashboard/lens/overview").json()
        assert overview_lens["view"] == "overview"
        assert overview_lens["totalValueGbp"] == 2000
        assert "accountReport" not in overview_lens
        positions_lens = client.get("/v1/dashboard/lens/holdings-positions").json()
        assert positions_lens["holdings"]
        assert {account["code"] for account in positions_lens["accounts"]} == {"A", "B"}
        assert positions_lens["totalUnrealizedPnlGbp"] == 100
        assert "nav" not in positions_lens
        lookthrough_lens = client.get("/v1/dashboard/lens/holdings-lookthrough").json()
        assert lookthrough_lens["lookthrough"]["available"] is True
        analytics_lens = client.get("/v1/dashboard/lens/analytics").json()
        assert analytics_lens["nav"]
        assert set(analytics_lens["benchmarkSeries"]) == {"VOO", "QQQ", "VT"}
        nav_start = analytics_lens["nav"][0]["date"][:10]
        nav_end = analytics_lens["nav"][-1]["date"][:10]
        assert all(
            nav_start <= point["date"][:10] <= nav_end
            for points in analytics_lens["benchmarkSeries"].values()
            for point in points
        )
        assert "lookthrough" not in analytics_lens
        review_lens = client.get("/v1/dashboard/lens/review").json()
        assert review_lens["view"] == "review"
        assert review_lens["accounts"]
        assert review_lens["risk"]
        assert "nav" not in review_lens
        assert "benchmarkSeries" not in review_lens
        account_lens = client.get("/v1/dashboard/lens/account-analysis?account=A").json()
        assert account_lens["selectedAccount"]["code"] == "A"
        assert account_lens["selectedAccountAnalysis"]["account"] == "A"
        cfd_account_lens = client.get("/v1/dashboard/lens/account-analysis?account=C")
        assert cfd_account_lens.status_code == 200
        assert cfd_account_lens.json()["view"] == "account-analysis"
        assert client.get("/v1/snapshots/latest").status_code == 200
        research = client.get("/v1/research?ticker=BE").json()
        assert research["selected"]["ticker"] == "BE"
        assert research["selected"]["latestEvent"]["eventType"] == "earnings"
        assert "priceSeries" not in research["selected"]["technical"]
        shell = client.get("/v1/research/shell").json()
        assert shell["status"]["runId"] == research["status"]["runId"]
        assert {item["ticker"] for item in shell["instruments"]} == {"BE", "NVDA"}
        assert "selected" not in shell
        valuation_lens = client.get("/v1/research/BE/lens/valuation").json()
        assert valuation_lens["view"] == "valuation"
        assert valuation_lens["valuation"]["ticker"] == "BE"
        assert valuation_lens["technical"] is None
        fundamentals_lens = client.get("/v1/research/BE/lens/fundamentals").json()
        assert fundamentals_lens["fundamentals"]["ticker"] == "BE"
        assert fundamentals_lens["financials"] is not None
        options_lens = client.get("/v1/research/BE/lens/options").json()
        assert options_lens["options"]["ticker"] == "BE"
        assert options_lens["valuation"] is None
        prices = client.get("/v1/research/BE/prices?limit=2")
        assert prices.status_code == 200
        assert prices.json()["ticker"] == "BE"
        assert len(prices.json()["points"]) <= 2
        assert client.get("/v1/research/status").status_code == 200
        instruments = client.get("/v1/research/instruments").json()
        assert len(instruments) == 2
        assert any(item["ticker"] == "BE" for item in instruments)
        assert all(item["ticker"] != "GOOGL" for item in instruments)
        watchlist = client.get("/v1/watchlist").json()
        assert len(watchlist["items"]) == 2
        assert watchlist["classificationSystem"] == "Trading Max LLM taxonomy"
        assert watchlist["classificationLevel"] == "Research theme"
        assert watchlist["categories"] == []
        assert watchlist["researchThemes"] == []
        assert client.get("/v1/research/BE/timeline").status_code == 200
        assert client.get("/v1/research/BE/models").status_code == 200
        assert client.get("/v1/research/BE/alerts").status_code == 200
        assert client.get("/v1/research/BE/portfolio-impact").json()["allocationPct"] == 0.5
        assert client.get("/v1/report").status_code == 404
        refresh_state = client.get("/v1/refresh-state").json()
        assert refresh_state["nightly"]["enabled"] is False
        assert refresh_state["intraday"]["enabled"] is False
        assert refresh_state["intraday"]["intervalSeconds"] == 600
        assert refresh_state["latestFullJob"] is None
        assert refresh_state["latestIntradayJob"] is None
        assert refresh_state["alerts"]["enabled"] is False
        assert client.get("/v1/alerts/status").status_code == 200


def test_overview_lens_includes_available_intraday_observations(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    previous = store.immutable_snapshots.latest()
    assert previous is not None
    intraday = store.immutable_artifacts.put_json(
        key="account/nav/intraday_anchors.json",
        payload={
            "schema_version": 1,
            "generated_at": "2026-08-18T19:20:02Z",
            "interval_seconds": 600,
            "retention_days": 14,
            "points": [
                {
                    "observed_at": "2026-08-17T19:20:02Z",
                    "bucket_at": "2026-08-17T19:20:00Z",
                    "invest_value_gbp": 1200,
                    "isa_value_gbp": 800,
                    "total_value_gbp": 2000,
                    "invest_cash_gbp": 200,
                    "isa_cash_gbp": 100,
                    "external_flow_gbp": None,
                    "flow_status": "unverified",
                    "source_artifact_ids": [],
                },
                {
                    "observed_at": "2026-08-18T19:20:02Z",
                    "bucket_at": "2026-08-18T19:20:00Z",
                    "invest_value_gbp": 1210,
                    "isa_value_gbp": 805,
                    "total_value_gbp": 2015,
                    "invest_cash_gbp": 200,
                    "isa_cash_gbp": 100,
                    "external_flow_gbp": None,
                    "flow_status": "unverified",
                    "source_artifact_ids": [],
                },
            ],
        },
        kind="intraday_nav",
        producer_version="test",
    )
    store.immutable_snapshots.publish(
        scope="intraday",
        source="test",
        artifacts=[*previous.manifest.artifacts, intraday],
    )
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        )
    )

    with TestClient(app) as client:
        overview = client.get("/v1/dashboard/lens/overview")
        analytics = client.get("/v1/dashboard/lens/analytics")
        account_analysis = client.get("/v1/dashboard/lens/account-analysis?account=A")

    assert overview.status_code == 200
    observations = overview.json()["intradayNav"]
    assert len(observations) == 1
    assert observations[0]["date"] == "2026-08-18T19:20:02Z"
    assert observations[0]["total"] == 2015
    assert [point["date"] for point in analytics.json()["intradayNav"]] == [
        "2026-08-17T19:20:02Z",
        "2026-08-18T19:20:02Z",
    ]
    assert [point["date"] for point in account_analysis.json()["intradayNav"]] == [
        "2026-08-17T19:20:02Z",
        "2026-08-18T19:20:02Z",
    ]


def test_research_price_series_is_scoped_and_bounded(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "watchlist.json"))
    raw = {
        "as_of": "2026-08-11",
        "rows": [
            {
                "ticker": "BE",
                "currency": "USD",
                "price_series": [
                    {
                        "date": f"2026-08-{day:02d}",
                        "open": float(day),
                        "high": float(day + 1),
                        "low": float(day - 1),
                        "close": float(day) + 0.5,
                        "volume": 1_000 * day,
                        "sma20": None,
                        "sma50": None,
                        "sma200": None,
                    }
                    for day in range(1, 6)
                ],
            },
            {
                "ticker": "NVDA",
                "currency": "USD",
                "price_series": [],
            },
        ],
    }
    monkeypatch.setattr(ledger, "_read_optional", lambda *_args: raw)

    result = ledger.price_series("be", manifest, limit=2)

    assert result.ticker == "BE"
    assert result.available_sessions == 5
    assert [point.date for point in result.points] == [
        "2026-08-04",
        "2026-08-05",
    ]


def test_unconfigured_llm_does_not_block_data_plane_readiness(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    _fixture_watchlist(tmp_path / "runtime")

    def missing_analysis(self, **kwargs):
        raise FileNotFoundError("analysis not generated")

    def unavailable_analysis(self, **kwargs):
        raise ProviderRuntimeError(
            "provider_not_configured",
            "selected provider is not configured",
        )

    monkeypatch.setattr(TypedAnalysisManager, "latest", missing_analysis)
    monkeypatch.setattr(TypedAnalysisManager, "submit", unavailable_analysis)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        ),
        credential_store=InMemoryCredentialStore(),
    )

    with TestClient(app) as client:
        ready = client.get("/ready")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"
        assert ready.json()["bootstrapError"] is None


def test_api_recovers_after_worker_publishes_first_snapshot(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    data_root = tmp_path / "runtime"
    app = create_app(
        Settings(
            data_root=data_root,
            api_token="secret",
            embedded_worker=True,
        )
    )

    with TestClient(app) as client:
        before = client.get("/health").json()
        assert before["status"] == "degraded"
        assert before["bootstrapError"] == (
            "FileNotFoundError: no typed snapshot has been published"
        )

        typed_fixture(research_root, ArtifactStore(data_root))

        after = client.get("/health").json()
        assert after["status"] == "ok"
        assert after["bootstrapError"] is None
        assert client.get("/ready").json()["status"] == "ready"


def test_account_snapshot_dashboard_does_not_require_research_artifacts(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    data_root = tmp_path / "runtime"
    store = ArtifactStore(data_root)
    manifest = typed_fixture(research_root, store)
    excluded = {
        "research/technical.json",
        "research/valuation.json",
        "research/options.json",
    }
    seeded = store.immutable_snapshots.load(manifest.run_id)
    store.immutable_snapshots.publish(
        scope="accounts",
        source="accounts-only-fixture",
        artifacts=[ref for ref in seeded.manifest.artifacts if ref.key not in excluded],
    )

    app = create_app(
        Settings(
            data_root=data_root,
            api_token="secret",
            embedded_worker=True,
        )
    )
    with TestClient(app) as client:
        dashboard = client.get("/v1/dashboard")
        assert dashboard.status_code == 200
        assert dashboard.json()["technical"] == []
        assert dashboard.json()["valuations"] == []
        assert dashboard.json()["options"] == []
        assert dashboard.json()["researchAsOf"] == ""

        overview = client.get("/v1/dashboard/lens/overview")
        assert overview.status_code == 200
        assert overview.json()["accounts"]
        assert overview.json().get("technical", []) == []
        assert overview.json().get("valuations", []) == []


def test_dashboard_normalizes_legacy_cfd_account_type(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    report = research_root / "accounts" / "outputs" / "three-account-report"
    analysis_path = report / "account_analysis_metrics.json"
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    analysis["accounts"]["C"] = {
        "account": "C",
        "name": "Historical CFD (closed)",
        "accountType": "historical-cfd",
        "metricQuality": "realized_trade_proxy",
        "riskNote": "Legacy imported CFD snapshot.",
    }
    analysis_path.write_text(json.dumps(analysis), encoding="utf-8")
    synthetic_path = report / "yahoo_nav" / "synthetic_nav_metrics.json"
    synthetic = json.loads(synthetic_path.read_text(encoding="utf-8"))
    synthetic["C"] = {
        "ending_nav_gbp": 70.0,
        "net_external_flows_gbp": 100.0,
        "realized_profit_loss_gbp": -30.0,
        "reconciliation_gap_gbp": 0.0,
        "reconciliation_status": "ok",
        "closed_positions": 1,
        "overnight_charges_gbp": -5.0,
        "nav_quality": "realized_cash_equity_proxy",
        "true_nav_available": False,
    }
    synthetic_path.write_text(json.dumps(synthetic), encoding="utf-8")

    data_root = tmp_path / "runtime"
    store = ArtifactStore(data_root)
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=data_root,
            api_token="secret",
            embedded_worker=True,
        )
    )

    with TestClient(app) as client:
        dashboard = client.get("/v1/dashboard")

    assert dashboard.status_code == 200
    assert dashboard.json()["accountAnalysis"]["C"]["accountType"] == "cfd-imported"
    assert dashboard.json()["accountAnalysis"]["C"]["name"] == "CFD"


def test_dashboard_omits_legacy_cfd_analysis_without_active_import(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    report = research_root / "accounts" / "outputs" / "three-account-report"
    analysis_path = report / "account_analysis_metrics.json"
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    analysis["accounts"]["C"] = {
        "account": "C",
        "name": "Historical CFD (closed)",
        "accountType": "historical-cfd",
        "metricQuality": "realized_trade_proxy",
        "riskNote": "Legacy imported CFD snapshot.",
    }
    analysis_path.write_text(json.dumps(analysis), encoding="utf-8")

    data_root = tmp_path / "runtime"
    store = ArtifactStore(data_root)
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=data_root,
            api_token="secret",
            embedded_worker=True,
        )
    )

    with TestClient(app) as client:
        dashboard = client.get("/v1/dashboard")

    assert dashboard.status_code == 200
    assert "C" not in dashboard.json()["accountAnalysis"]


def test_immutable_snapshot_views_are_cached_per_run(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    monkeypatch,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    dashboard_calls = 0
    research_calls = 0
    real_dashboard = app_module.build_dashboard_data
    real_research = ResearchLedger.overview

    def counted_dashboard(*args, **kwargs):
        nonlocal dashboard_calls
        dashboard_calls += 1
        return real_dashboard(*args, **kwargs)

    def counted_research(self, *args, **kwargs):
        nonlocal research_calls
        research_calls += 1
        return real_research(self, *args, **kwargs)

    monkeypatch.setattr(app_module, "build_dashboard_data", counted_dashboard)
    monkeypatch.setattr(ResearchLedger, "overview", counted_research)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        )
    )

    with TestClient(app) as client:
        assert client.get("/v1/dashboard").status_code == 200
        assert client.get("/v1/dashboard").status_code == 200
        assert client.get("/v1/research?ticker=BE").status_code == 200
        assert client.get("/v1/research?ticker=BE").status_code == 200

    assert dashboard_calls == 1
    assert research_calls == 1


def test_watchlist_mutations_require_auth_and_preserve_pending_state(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    _fixture_watchlist(tmp_path / "runtime")
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=True,
        )
    )
    request = {
        "categoryId": "gics-45103020",
        "refresh": False,
        "security": {
            "ticker": "MSFT",
            "name": "Microsoft Corp",
            "exchange": "NASDAQ",
            "bloombergTicker": "MSFT US Equity",
            "figi": "BBG000BPH459",
            "securityType": "Common Stock",
            "alreadyWatched": False,
        },
    }
    with TestClient(app) as client:
        assert client.post("/v1/watchlist", json=request).status_code == 401
        response = client.post(
            "/v1/watchlist",
            json=request,
            headers={"Authorization": "Bearer secret"},
        )
        assert response.status_code == 202
        assert response.json()["item"]["ticker"] == "MSFT"
        assert response.json()["item"]["status"] == "pending"
        assert response.json()["item"]["categoryId"] == ""
        assert response.json()["item"]["researchThemeId"] is None
        assert response.json()["item"]["taxonomyStatus"] == "unclassified"
        assert response.json()["item"]["gics"] is None
        overview = client.get("/v1/research?ticker=MSFT").json()
        assert overview["selected"]["ticker"] == "MSFT"
        assert any(
            item["ticker"] == "MSFT"
            and item["status"] == "pending"
            and item["taxonomyStatus"] == "unclassified"
            for item in overview["instruments"]
        )
        removed = client.post(
            "/v1/watchlist/MSFT/remove",
            headers={"Authorization": "Bearer secret"},
        )
        assert removed.status_code == 200
        assert all(item["ticker"] != "MSFT" for item in client.get("/v1/watchlist").json()["items"])


def test_watchlist_refresh_is_scoped_to_the_selected_ticker(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    """A single-ticker research refresh must not recompute the whole watchlist."""

    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    _fixture_watchlist(tmp_path / "runtime")
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=False,
        )
    )
    with TestClient(app) as client:
        watched = client.get("/v1/watchlist").json()["items"]
        assert len(watched) > 1
        target = watched[0]["ticker"]

        response = client.post(
            f"/v1/watchlist/{target}/refresh",
            headers={"Authorization": "Bearer secret"},
        )
        assert response.status_code == 202
        job = response.json()["job"]
        assert job["scope"] == "research"
        assert job["tickers"] == [target]
        assert response.json()["item"]["status"] == "pending"
        refreshed = client.get("/v1/watchlist").json()["items"]
        assert next(item for item in refreshed if item["ticker"] == target)["status"] == "pending"

        # The sidebar pipeline card reports account freshness, so a research
        # job must never become the reported "latest full job".
        state = client.get("/v1/refresh-state").json()
        assert state["latestJob"]["jobId"] == job["jobId"]
        assert state["latestFullJob"] is None


def test_refresh_is_authenticated_and_publishes_new_snapshot(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=False,
        )
    )
    with TestClient(app) as client:
        assert client.post("/v1/jobs/refresh", json={}).status_code == 401
        response = client.post(
            "/v1/jobs/refresh",
            json={"scope": "research", "skipSync": True, "tickers": ["BE"]},
            headers={"Authorization": "Bearer secret"},
        )
        assert response.status_code == 202
        assert response.json()["trigger"] == "on_demand"
        job_id = response.json()["jobId"]

        payload = client.get(f"/v1/jobs/{job_id}").json()
        assert payload["status"] == "queued"
        assert payload["jobId"] == job_id
        assert payload["stages"][0]["name"] == "market.snapshot"


def test_valuation_assumptions_api_requires_auth_and_upserts(
    tmp_path: Path,
) -> None:
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            embedded_worker=False,
        )
    )
    with TestClient(app) as client:
        overview = client.get("/v1/valuation/assumptions")
        assert overview.status_code == 200
        assert len(overview.json()["companies"]) >= 50

        unauthorized = client.put(
            "/v1/valuation/assumptions/BE",
            json={
                "scenarios": {
                    "base": {"revenueCagr": 0.21},
                },
                "source": "manual",
            },
        )
        assert unauthorized.status_code == 401

        response = client.put(
            "/v1/valuation/assumptions/BE",
            headers={"Authorization": "Bearer secret"},
            json={
                "scenarios": {
                    "base": {"revenueCagr": 0.21},
                },
                "source": "manual",
            },
        )
        assert response.status_code == 200
        company = next(item for item in response.json()["companies"] if item["ticker"] == "BE")
        assert company["scenarios"]["base"]["revenueCagr"] == 0.21

        history = client.get("/v1/valuation/assumptions/history?limit=20")
        assert history.status_code == 200
        entries = history.json()
        assert entries
        assert entries[0]["ticker"] == "BE"
        assert "base.revenueCagr" in entries[0]["changes"]
