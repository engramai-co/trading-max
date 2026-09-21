import sqlite3
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

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

    def load(_store, manifest):
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
