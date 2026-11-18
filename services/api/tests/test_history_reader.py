import json
import sqlite3
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from trading_max.application import AccountSnapshotStage, StageContext

from services.api.trading_max_api import history_reader as module
from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.dashboard_models import NavPoint
from services.api.trading_max_api.history_projection import project_intraday, scope_points
from services.api.trading_max_api.history_reader import HistoryReader


def point(date, value=100, source="broker"):
    fields = {name: None for name, field in NavPoint.model_fields.items() if field.is_required()}
    return NavPoint(
        **{
            **fields,
            "date": date,
            "intraday": "T" in date,
            "flow_status": "verified",
            "total": value,
            "invest": value * 0.7,
            "isa": value * 0.3,
            "household": value,
            "valuation_source": source,
            "total_net_contributions_gbp": 80,
        }
    )


@pytest.fixture
def indexed(tmp_path, monkeypatch):
    store = ArtifactStore(tmp_path)
    monkeypatch.setattr(
        store,
        "read_json",
        lambda run, key: (
            {"generated_at_utc": "2026-09-18T23:10Z"}
            if key == "account/broker_snapshot_metrics.json"
            else None
        ),
    )
    daily = [point("2026-02-01"), point("2026-09-18")]
    rows = [
        point("2026-03-18T12:00Z", source="reconstructed"),
        point("2026-08-10T12:00Z"),
        point("2026-09-18T12:00Z", 100),
        point("2026-09-18T12:10Z", 20),
        point("2026-09-18T12:20Z", 110),
    ]
    calls = []

    def load(_store, manifest, *, scope=None):
        calls.append(manifest.run_id)
        return daily, rows + ([point("2026-09-18T12:30Z", 111)] if manifest.run_id != "one" else [])

    monkeypatch.setattr(module, "load_history", load)

    def manifest(run="one", revision="a"):
        return SimpleNamespace(
            run_id=run,
            created_at=datetime.now(UTC),
            artifacts=[SimpleNamespace(key="account/nav/valuation_history.json", sha256=revision)],
        )

    return HistoryReader(store), manifest, daily, rows, calls


@pytest.mark.parametrize("scope", ["invest", "isa", "total", "household", "cfd"])
@pytest.mark.parametrize("range_name", ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "ALL"])
def test_query_matches_lossless_projection(indexed, range_name, scope):
    reader, manifest, daily, rows, calls = indexed
    result = reader.read(manifest(), range_name, scope)
    assert result.nav == scope_points(daily, scope)
    assert result.intraday_nav == project_intraday(
        rows, daily, as_of=result.broker_as_of, range_name=range_name, scope=scope
    )
    assert calls == ["one"]


def test_increment_reuses_rows_and_research_revision_while_old_snapshot_stays_pinned(indexed):
    reader, manifest, _, _, calls = indexed
    a = reader.read(manifest(), "ALL", "total")
    reader.read(manifest("research-only"), "ALL", "total")
    b = reader.read(manifest("two", "b"), "ALL", "total")
    assert len(b.intraday_nav) == len(a.intraday_nav) + 1
    assert reader.read(manifest(), "ALL", "total").intraday_nav == a.intraday_nav
    assert calls == ["one", "two"]
    with sqlite3.connect(reader.path) as con:
        assert con.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 8
    for i in range(8):
        reader.read(manifest(f"new-{i}", f"new-{i}"), "1D", "total")
    with sqlite3.connect(reader.path) as con:
        assert con.execute("SELECT COUNT(*) FROM datasets").fetchone()[0] == 2
        assert con.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 8


def test_concurrent_readers_build_once_and_missing_index_rebuilds(indexed):
    reader, manifest, _, _, calls = indexed
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: reader.read(manifest(), "6M", "total"), range(8)))
    assert calls == ["one"] and all(r == results[0] for r in results)
    reader.path.unlink()
    assert reader.read(manifest(), "6M", "total") == results[0]
    assert calls == ["one", "one"]


def test_corrupt_row_never_becomes_a_changed_balance(indexed):
    reader, manifest, _, _, _ = indexed
    expected = reader.read(manifest(), "6M", "total")
    with sqlite3.connect(reader.path) as con:
        payload = point("2026-09-18T12:10Z", 999999).model_dump_json().encode()
        con.execute("UPDATE observations SET payload=?", (zlib.compress(payload),))
    assert reader.read(manifest(), "6M", "total") == expected
    # Evidence of the cache failure is retained; immutable originals are untouched.
    assert reader.path.exists()


def test_cache_budget_does_not_prune_original_history(indexed):
    reader, manifest, _, rows, _ = indexed
    reader.byte_limit = 1
    assert len(reader.read(manifest(), "ALL", "total").intraday_nav) == len(rows)
    with sqlite3.connect(reader.path) as con:
        assert con.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 0
    assert len(reader.read(manifest(), "ALL", "total").intraday_nav) == len(rows)


def test_api_matches_legacy_and_summary_avoids_history(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=True))
    with TestClient(app) as client:
        legacy = client.get("/v1/dashboard/lens/analytics?range=6M&scope=total").json()
        run = legacy["runId"]
        result = client.get(f"/v1/dashboard/history?range=6M&scope=total&run_id={run}")
        assert result.status_code == 200
        assert result.json().get("nav", []) == legacy.get("nav", [])
        assert result.json().get("intradayNav", []) == legacy.get("intradayNav", [])
        assert client.get("/v1/dashboard/history?run_id=missing-snapshot").status_code == 404
        assert client.get("/v1/dashboard/history?run_id=..%2Fsecrets").status_code == 422
        original = app.state.store.read_json

        def no_history(run, key):
            assert key not in {
                "account/nav/valuation_history.json",
                "account/nav/intraday_anchors.json",
            }
            return original(run, key)

        monkeypatch.setattr(app.state.store, "read_json", no_history)
        summary = client.get("/v1/dashboard/lens/analytics?detail=summary&scope=total")
        assert summary.status_code == 200
        assert not summary.json().get("intradayNav")


def test_analytics_lens_pins_nav_and_prices_and_rechecks_retention(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=True))
    lens = "/v1/dashboard/lens/analytics?detail=summary&scope=isa"
    with TestClient(app) as client:
        original = client.get(lens).json()
        run = original["runId"]
        nav = next(research_root.rglob("daily_nav_b.csv"))
        nav.write_text(nav.read_text().replace(",1.02,0", ",1.09,0"))
        technical = next(research_root.rglob("technical_analysis_*.json"))
        payload = json.loads(technical.read_text())
        payload["benchmark_series"]["VOO"][0]["close"] = 110
        technical.write_text(json.dumps(payload))
        typed_fixture(research_root, store)
        newer = client.get(lens).json()
        assert newer["runId"] != run
        assert newer["nav"] != original["nav"]
        assert newer["benchmarkSeries"] != original["benchmarkSeries"]
        pinned_url = f"{lens}&run_id={run}"
        from unittest.mock import Mock

        retained_store = app.state.store
        metadata = Mock(wraps=retained_store._api_manifest)
        monkeypatch.setattr(retained_store, "_api_manifest", metadata)
        full_dashboard = Mock(wraps=app.state.cached_dashboard)
        monkeypatch.setattr(app.state, "cached_dashboard", full_dashboard)
        for view in ("overview", "holdings-positions", "account-analysis", "review"):
            assert client.get(f"/v1/dashboard/lens/{view}?run_id={run}").status_code == 422
        for _ in range(3):
            response = client.get(pinned_url)
            assert response.status_code == 200
        assert metadata.call_count <= 1
        full_dashboard.assert_not_called()
        cited = response.json()
        assert set(cited) <= {
            "view",
            "runId",
            "generatedAt",
            "brokerAsOf",
            "researchAsOf",
            "nav",
            "benchmarkSeries",
        }
        assert all(set(row) <= {"date", "flowStatus", "isa", "isaTwr"} for row in cited["nav"])
        assert cited["runId"] == run
        assert [(p["date"], p.get("isaTwr")) for p in cited["nav"]] == [
            (p["date"], p.get("isaTwr")) for p in original["nav"]
        ]
        assert cited["benchmarkSeries"] == original["benchmarkSeries"]
        # The retention worker and API have independent, warm manifest caches.
        monkeypatch.setenv("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "0")
        assert run in store.prune_snapshots(keep_recent=1)
        assert client.get(pinned_url).status_code == 404


def test_retained_returns_cannot_evict_the_live_dashboard(research_root, tmp_path, typed_fixture):
    store = ArtifactStore(tmp_path / "state")
    publications = []
    for _ in range(6):
        typed_fixture(research_root, store)
        publications.append(store.latest_manifest())
    app = create_app(Settings(data_root=store.data_root, embedded_worker=True))
    with TestClient(app) as client:
        live = app.state.cached_dashboard(publications[-1], include_history=False)
        for publication in publications[:-1]:
            result = client.get(
                "/v1/dashboard/lens/analytics",
                params={
                    "scope": "invest",
                    "detail": "summary",
                    "run_id": publication.run_id,
                },
            )
            assert result.status_code == 200
        assert app.state.cached_dashboard(publications[-1], include_history=False) is live


def test_retained_risk_and_holdings_use_only_page_records(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "retained")
    typed_fixture(research_root, store)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=True))
    with TestClient(app) as client:
        live = client.get("/v1/dashboard/lens/analytics?scope=isa&detail=summary").json()
        run = live["runId"]
        current_holdings = client.get("/v1/dashboard/lens/holdings-lookthrough").json()
        live_positions = client.get("/v1/dashboard/lens/holdings-positions").json()
        typed_fixture(research_root, store)
        monkeypatch.setattr(
            app.state, "cached_dashboard", lambda *a, **kw: pytest.fail("loaded full dashboard")
        )
        base = {"run_id": run, "detail": "summary"}
        source = app.state.store.read_text

        def only_isa(run_id, key):
            if key.endswith(("daily_nav_a.csv", "daily_nav_c.csv")):
                raise FileNotFoundError(key)
            return source(run_id, key)

        monkeypatch.setattr(app.state.store, "read_text", only_isa)
        selected = client.get(
            "/v1/dashboard/lens/analytics", params={**base, "scope": "isa", "projection": "risk"}
        )
        assert selected.status_code == 200
        risk = selected.json()
        assert risk["risk"] == {"B": live["risk"]["B"]}
        assert [(p["date"], p.get("isaDrawdown")) for p in risk["nav"]] == [
            (p["date"], p.get("isaDrawdown")) for p in live["nav"]
        ]
        assert [p.get("isaTwr") for p in risk["nav"]] == [p.get("isaTwr") for p in live["nav"]]
        assert any(p.get("isaTwr") is not None for p in risk["nav"])
        assert all(
            set(p) <= {"date", "isa", "isaTwr", "isaDrawdown", "flowStatus"} for p in risk["nav"]
        )
        assert not {"accounts", "benchmarkSeries", "holdings"} & risk.keys()
        holdings = client.get("/v1/dashboard/lens/holdings-lookthrough", params=base)
        assert holdings.status_code == 200
        assert holdings.json().get("lookthrough") == current_holdings.get("lookthrough")
        assert not {"accounts", "risk", "nav", "benchmarkSeries"} & holdings.json().keys()
        positions = client.get(
            "/v1/dashboard/lens/holdings-positions", params={**base, "account": "B"}
        ).json()
        isa = next(row for row in live_positions["accounts"] if row["code"] == "B")
        assert positions.get("positionAsOf") == {"B": isa["asOf"]}
        assert positions["totalInvestedGbp"] == isa["investedGbp"]
        assert positions["totalUnrealizedPnlGbp"] == isa["unrealizedPnlGbp"]
        assert positions.get("holdings", []) == [
            row for row in live_positions.get("holdings", []) if row["account"] == "B"
        ]
        assert not {"accounts", "risk", "nav", "benchmarkSeries", "lookthrough"} & positions.keys()


def test_retained_positions_match_live_worker_amounts(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)
    for profile, value, cost, stamp in [
        ("invest", "210.50", "200", "2026-08-01T18:00:00Z"),
        ("isa", "700.25", "720", "2026-08-01T19:00:00Z"),
    ]:
        pnl = str(Decimal(value) - Decimal(cost))
        path = store.data_root / "trading212" / profile / "snapshots" / "snapshot_test.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(
                {
                    "fetched_at_utc": stamp,
                    "account_summary": {
                        "currency": "GBP",
                        "totalValue": str(Decimal(value) + 100),
                        "cash": {"availableToTrade": "100"},
                        "investments": {
                            "currentValue": value,
                            "totalCost": cost,
                            "realizedProfitLoss": "0",
                            "unrealizedProfitLoss": pnl,
                        },
                    },
                    "positions": [
                        {
                            "instrument": {
                                "ticker": "SYNl_EQ",
                                "name": "Synthetic",
                                "isin": "GB0000000012",
                                "currency": "GBP",
                            },
                            "quantity": "1",
                            "currentPrice": value,
                            "walletImpact": {
                                "currentValue": value,
                                "totalCost": cost,
                                "unrealizedProfitLoss": pnl,
                            },
                        }
                    ],
                }
            )
        )
    result = AccountSnapshotStage(store.data_root, store.immutable_artifacts).run(
        StageContext(job_id="synthetic", scope="accounts")
    )
    base = store.immutable_snapshots.latest().manifest.artifacts
    replaced = {ref.key for ref in result.artifacts}
    run = store.immutable_snapshots.publish(
        scope="all",
        source="test",
        artifacts=[*[ref for ref in base if ref.key not in replaced], *result.artifacts],
    ).manifest.run_id
    broker = store.read_json(run, "account/broker_snapshot_metrics.json")
    assert broker["accounts"]["B"]["investments_value_gbp"] == "700.25"
    path = "/v1/dashboard/lens/holdings-positions"
    app = create_app(Settings(data_root=store.data_root, embedded_worker=False))
    with TestClient(app, raise_server_exceptions=False) as client:
        live = client.get(path, params={"detail": "summary"}).json()
        assert live["runId"] == run
        typed_fixture(research_root, store)
        for account, invested, pnl in [(None, 910.75, -9.25), ("B", 700.25, -19.75)]:
            params = {"run_id": run, "detail": "summary"}
            if account:
                params["account"] = account
            response = client.get(path, params=params)
            assert response.status_code == 200
            actual = response.json()
            rows = [row for row in live["holdings"] if account is None or row["account"] == account]
            assert actual["holdings"] == rows
            assert actual["totalInvestedGbp"] == invested
            assert actual["totalUnrealizedPnlGbp"] == pnl
            for row in rows:
                code = row["account"]
                assert (
                    actual["positionAsOf"][code]
                    == live["positionAsOf"][code]
                    == broker["accounts"][code]["fetched_at"]
                )
                assert row["allocationPct"] == pytest.approx(row["currentValueGbp"] / 1110.75)
        monkeypatch.setenv("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "0")
        assert run in store.prune_snapshots(keep_recent=1)
        assert client.get(path, params={"run_id": run, "detail": "summary"}).status_code == 404


def test_retained_isa_history_survives_a_missing_invest_ledger(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "state")
    run = typed_fixture(research_root, store).run_id
    typed_fixture(research_root, store)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=False))
    original = app.state.store.read_text
    original_json = app.state.store.read_json
    reads = []

    def selected_json(run_id, key):
        if run_id == run and key.endswith("cash_flows_a.json"):
            pytest.fail("ISA Money opened the Invest flow history")
        return original_json(run_id, key)

    def missing_invest(run_id, key):
        reads.append(key)
        if run == run_id and key.endswith("daily_nav_a.csv"):
            raise FileNotFoundError(key)
        return original(run_id, key)

    monkeypatch.setattr(app.state.store, "read_text", missing_invest)
    monkeypatch.setattr(app.state.store, "read_json", selected_json)
    with TestClient(app, raise_server_exceptions=False) as client:
        path = "/v1/dashboard/history"
        params = {"range": "ALL", "run_id": run}
        response = client.get(path, params={**params, "scope": "isa"})
        assert response.status_code == 200
        assert response.headers["X-History-Retained"] == "1"
        assert response.json()["nav"] and all(
            row.get("isa") is not None for row in response.json()["nav"]
        )
        assert reads.count("account/nav/daily_nav_b.csv") == 1
        for scope in ("total", "household", "invest"):
            assert client.get(path, params={**params, "scope": scope}).status_code == 404
        assert client.get(path, params={**params, "scope": "isa"}).json() == response.json()
        assert client.get(path, params={"range": "ALL", "scope": "total"}).status_code == 200


def test_scoped_cache_rebuilds_when_another_ledger_adds_a_date(tmp_path):
    from services.api.tests.assistant_fixture import publication

    store = ArtifactStore(tmp_path)
    header = "Date,SyntheticNAVGBP,ExternalFlowGBP\n"
    ledgers = {
        "account/nav/daily_nav_a.csv": header + "2026-01-28,800,800\n",
        "account/nav/daily_nav_b.csv": header + "2026-01-28,100,100\n",
    }
    earlier = publication(store, with_cfd=False, extra_files=ledgers)
    # A CFD-only date changes the calendar without changing either broker ledger.
    ledgers["account/nav/daily_nav_c.csv"] = "Date,RealisedCashEquityProxyGBP\n2026-01-29,5000\n"
    later = publication(store, with_cfd=False, extra_files=ledgers)
    publication(store)
    reader = HistoryReader(store, retained=True)
    original = reader.read(earlier, "ALL", "isa")
    revised = reader.read(later, "ALL", "isa")
    assert [(p.date, p.isa) for p in original.nav] == [("2026-01-28", 100)]
    assert [(p.date, p.isa) for p in revised.nav] == [("2026-01-28", 100), ("2026-01-29", 100)]
    assert original.data_revision != revised.data_revision
    assert reader.read(earlier, "ALL", "isa") == original


def test_retained_household_requires_its_published_cfd_ledger(tmp_path, monkeypatch):
    from services.api.tests.assistant_fixture import publication

    store = ArtifactStore(tmp_path / "state")
    run = publication(store).run_id
    app = create_app(Settings(data_root=store.data_root, embedded_worker=False))
    original = app.state.store.read_text

    def missing_cfd(run_id, key):
        if run == run_id and key.endswith("daily_nav_c.csv"):
            raise FileNotFoundError(key)
        return original(run_id, key)

    monkeypatch.setattr(app.state.store, "read_text", missing_cfd)
    with TestClient(app) as client:
        path = "/v1/dashboard/history"
        for archived in (False, True):
            if archived:
                publication(store)
            for scope, expected in [("total", 200), ("household", 404), ("cfd", 404)]:
                response = client.get(path, params={"run_id": run, "scope": scope})
                assert response.status_code == expected
                if expected == 200:
                    assert ("X-History-Retained" in response.headers) == archived


def test_archived_money_revisions_do_not_evict_live_history(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "history")
    ledger = next(research_root.rglob("daily_nav_b.csv"))
    original = ledger.read_text()
    runs = []
    for value in ("1.03", "1.05", "1.08", "1.11"):
        ledger.write_text(original.replace(",1.02,0", f",{value},0"))
        typed_fixture(research_root, store)
        runs.append(store.latest_manifest().run_id)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=False))
    with TestClient(app) as client:
        endpoint = "/v1/dashboard/history"
        builds = []
        load = module.load_history

        def record_build(store, manifest, *, scope=None):
            builds.append(manifest.run_id)
            return load(store, manifest, scope=scope)

        monkeypatch.setattr(module, "load_history", record_build)
        assert client.get(endpoint, params={"run_id": runs[-1]}).is_success
        for run in runs[:-1]:
            archived = client.get(endpoint, params={"run_id": run})
            assert archived.is_success
            assert archived.headers["X-History-Retained"] == "1"
            assert (
                client.head(endpoint, params={"run_id": run}).headers["X-History-Retained"] == "1"
            )
        count = builds.count(runs[-1])
        assert client.get(endpoint, params={"run_id": runs[-1]}).is_success
        assert builds.count(runs[-1]) == count
        monkeypatch.setenv("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "0")
        assert runs[0] in store.prune_snapshots(keep_recent=1)
        assert client.head(endpoint, params={"run_id": runs[0]}).status_code == 404
        assert client.head(endpoint, params={"run_id": runs[-1]}).status_code == 204


def test_retained_account_decisions_reopen_the_original_then_expire(
    research_root, tmp_path, typed_fixture, monkeypatch
):
    store = ArtifactStore(tmp_path / "state")
    typed_fixture(research_root, store)
    base = store.immutable_snapshots.latest().manifest.artifacts

    def publish_decision(amount):
        item = {
            "date": "2026-11-25",
            "ticker": "ALFA",
            "name": "Synthetic",
            "side": "buy",
            "kind": "B",
            "amount_gbp": amount,
        }
        artifact = store.immutable_artifacts.put_json(
            key="account/decisions.json",
            payload={"accounts": {"A": {"status": "available", "decisions": [item]}}},
        )
        return store.immutable_snapshots.publish(
            scope="all",
            source="test",
            artifacts=[
                *[entry for entry in base if entry.key != "account/decisions.json"],
                artifact,
            ],
        ).manifest.run_id

    old = publish_decision(125)
    new = publish_decision(950)
    app = create_app(Settings(data_root=store.data_root, embedded_worker=True))
    with TestClient(app) as client:
        path = "/v1/dashboard/lens/account-analysis"
        params = {"detail": "summary", "account": "A"}
        for run, amount in [(new, 950), (old, 125)]:
            response = client.get(path, params={**params, "run_id": run})
            assert response.status_code == 200
            data = response.json()
            assert data["runId"] == run
            assert data["selectedAccountDecisions"]["decisions"][0]["amountGbp"] == amount
        monkeypatch.setenv("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "0")
        assert old in store.prune_snapshots(keep_recent=1)
        assert client.get(path, params={**params, "run_id": old}).status_code == 404
