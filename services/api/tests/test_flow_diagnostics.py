from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from trading_max.infrastructure import ArtifactIntegrityError

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.dashboard import _intraday_nav_points
from services.api.trading_max_api.flow_diagnostics import SnapshotFlowDiagnostics
from services.api.trading_max_api.intraday_scheduler import IntradayScheduler


def _anchor(stamp="2026-01-05T12:00:00Z", **extra):
    return {
        "observed_at": stamp,
        "bucket_at": stamp,
        "invest_value_gbp": 100,
        "isa_value_gbp": 100,
        "total_value_gbp": 200,
        "invest_cash_gbp": 0,
        "isa_cash_gbp": 0,
        **extra,
    }


def _history(points):
    return {
        "generated_at": "2026-01-06T12:00:00Z",
        "interval_seconds": 600,
        "retention_days": 210,
        "points": points,
    }


def _flows(end="2026-01-05T12:00:00Z", **extra):
    return {
        "covered_from": "2026-01-01T00:00:00Z",
        "covered_until": end,
        "verified": True,
        "events": [],
        **extra,
    }


def _publish(store, payloads):
    return store.publish_typed(
        scope="all",
        source="synthetic-diagnostic-test",
        artifacts=[
            store.immutable_artifacts.put_json(key=key, payload=value)
            for key, value in payloads.items()
        ],
    )


def test_no_snapshot_and_missing_history_are_unknown_not_zero(tmp_path):
    store = ArtifactStore(tmp_path)
    diagnostics = SnapshotFlowDiagnostics(store)
    empty = diagnostics.status()
    assert empty.flow_verification_status == "no_snapshot"
    assert empty.flow_unverified_count is None
    assert empty.flow_anchor_count is None
    assert empty.flow_snapshot_run_id is None

    manifest = _publish(store, {"research/example.json": {}})
    missing = diagnostics.status()
    assert missing.flow_verification_status == "unavailable"
    assert missing.flow_snapshot_run_id == manifest.run_id
    assert missing.flow_unverified_count is None


@pytest.mark.parametrize("error", [OSError, ValueError, ArtifactIntegrityError])
def test_unreadable_manifest_does_not_break_health_diagnostics(tmp_path, monkeypatch, error):
    store = ArtifactStore(tmp_path)

    def unreadable():
        raise error("synthetic manifest failure")

    monkeypatch.setattr(store, "latest_manifest", unreadable)
    result = SnapshotFlowDiagnostics(store).status()
    assert result.flow_verification_status == "unavailable"
    assert result.flow_unverified_count is None
    assert result.flow_snapshot_run_id is None


def test_corrupt_latest_pointer_is_unavailable_even_when_store_suppresses_the_error(tmp_path):
    store = ArtifactStore(tmp_path)
    store.immutable_snapshots.latest_path.write_text("{broken", encoding="utf-8")
    assert store.latest_manifest() is None
    result = SnapshotFlowDiagnostics(store).status()
    assert result.flow_verification_status == "unavailable"
    assert result.flow_unverified_count is None


def test_counts_effective_current_anchor_coverage_like_the_dashboard(tmp_path):
    store = ArtifactStore(tmp_path)
    history = _history(
        [
            _anchor("2026-01-01T12:00:00Z", source="reconstructed"),
            _anchor(
                "2026-01-05T12:00:01Z",
                invest_observed_at="2026-01-05T11:59:59Z",
                isa_observed_at="2026-01-05T12:00:01Z",
            ),
            _anchor("2026-01-06T12:00:00Z"),
            _anchor("2026-01-06T12:10:00Z", flow_status="verified"),
        ]
    )
    flows = {"invest": _flows(), "isa": _flows("2026-01-05T13:00:00Z")}
    manifest = _publish(
        store,
        {
            "account/nav/valuation_history.json": history,
            "account/nav/cash_flows_a.json": flows["invest"],
            "account/nav/cash_flows_b.json": flows["isa"],
        },
    )
    result = SnapshotFlowDiagnostics(store).status()
    assert result.flow_snapshot_run_id == manifest.run_id
    assert result.flow_verification_status == "available"
    assert result.flow_anchor_count == 4
    assert result.flow_unverified_count == 1
    assert result.flow_unverified_count == sum(
        point["flowStatus"] != "verified" for point in _intraday_nav_points(history, flows)
    )


@pytest.mark.parametrize("b_flows", [None, _flows(verified=False), {"verified": True}])
def test_one_missing_or_unverified_account_does_not_certify_an_anchor(tmp_path, b_flows):
    store = ArtifactStore(tmp_path)
    payloads = {
        "account/nav/valuation_history.json": _history([_anchor()]),
        "account/nav/cash_flows_a.json": _flows(),
    }
    if b_flows is not None:
        payloads["account/nav/cash_flows_b.json"] = b_flows
    _publish(store, payloads)
    assert SnapshotFlowDiagnostics(store).status().flow_unverified_count == 1


def test_new_snapshot_reconciliation_reduces_count_and_legacy_history_is_supported(tmp_path):
    store = ArtifactStore(tmp_path)
    diagnostics = SnapshotFlowDiagnostics(store)
    history = {"account/nav/intraday_anchors.json": _history([_anchor()])}
    first = _publish(store, history)
    assert diagnostics.status().flow_unverified_count == 1
    second = _publish(
        store,
        {
            **history,
            "account/nav/cash_flows_a.json": _flows(),
            "account/nav/cash_flows_b.json": _flows(),
        },
    )
    assert second.run_id != first.run_id
    assert diagnostics.status().flow_unverified_count == 0
    assert diagnostics.status().flow_snapshot_run_id == second.run_id


def test_empty_history_has_zero_anchors_and_malformed_history_is_unavailable(tmp_path):
    store = ArtifactStore(tmp_path)
    diagnostics = SnapshotFlowDiagnostics(store)
    _publish(store, {"account/nav/valuation_history.json": _history([])})
    assert diagnostics.status().flow_anchor_count == 0
    assert diagnostics.status().flow_unverified_count == 0
    _publish(
        store,
        {
            "account/nav/valuation_history.json": {"points": "invalid"},
            "account/nav/intraday_anchors.json": _history([_anchor(flow_status="verified")]),
        },
    )
    assert diagnostics.status().flow_verification_status == "unavailable"
    assert diagnostics.status().flow_unverified_count is None


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("performance", [False, True])
def test_schedule_job_totals_never_stand_in_for_current_coverage(tmp_path, enabled, performance):
    class Jobs:
        def trigger_summary(self, _trigger):
            return None, {"succeeded": 1200, "failed": 3}

    store = ArtifactStore(tmp_path)
    _publish(store, {"account/nav/valuation_history.json": _history([_anchor()])})
    scheduler = IntradayScheduler(
        Jobs(),
        enabled=enabled,
        timezone="UTC",
        interval_seconds=600,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        performance=performance,
        flow_diagnostics=SnapshotFlowDiagnostics(store).status,
        now=lambda: datetime(2026, 1, 6, tzinfo=UTC),
    )
    status = scheduler.status()
    assert status.succeeded_count == 1200
    assert status.flow_unverified_count == 1
    assert status.flow_anchor_count == 1


def test_refresh_state_exposes_unknown_then_current_snapshot_for_all_schedule_aliases(tmp_path):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        before = client.get("/v1/refresh-state").json()
        for name in ("intraday", "live", "performance"):
            assert before[name]["flowVerificationStatus"] == "no_snapshot"
            assert before[name]["flowUnverifiedCount"] is None
        manifest = _publish(
            app.state.store,
            {"account/nav/valuation_history.json": _history([_anchor()])},
        )
        after = client.get("/v1/refresh-state").json()
        for name in ("intraday", "live", "performance"):
            assert after[name]["flowVerificationStatus"] == "available"
            assert after[name]["flowSnapshotRunId"] == manifest.run_id
            assert after[name]["flowUnverifiedCount"] == 1
            assert after[name]["succeededCount"] == 0
