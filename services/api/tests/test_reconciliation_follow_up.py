"""Research summary publication must not clear a failed ledger reconciliation."""

from copy import deepcopy
from types import SimpleNamespace

from trading_max.analytics.cash_flow_history import account_state_digest

from services.api.trading_max_api.typed_jobs import performance_refresh_needed


def test_research_summary_cannot_hide_changed_unreconciled_account():
    reconciled = {
        "cash_gbp": 10,
        "positions": [
            {"isin": "US0000000001", "ticker": "TEST", "quantity": 2, "total_cost_gbp": 20}
        ],
    }
    current = {
        "cash_gbp": 20,
        "positions": [
            {"isin": "US0000000001", "ticker": "TEST", "quantity": 1, "total_cost_gbp": 10}
        ],
    }
    payloads = {
        "account/intraday/broker_values.json": {"accounts": {"B": current}},
        "account/broker_snapshot_metrics.json": {"accounts": {"B": deepcopy(current)}},
        "account/nav/cash_flows_b.json": {
            "verified": True,
            "account_state_digest": account_state_digest(reconciled),
        },
    }
    store = SimpleNamespace(
        latest_manifest=lambda: SimpleNamespace(run_id="synthetic"),
        read_json=lambda _run, key: payloads[key],
    )
    assert performance_refresh_needed(store)
    payloads["account/nav/cash_flows_b.json"]["account_state_digest"] = account_state_digest(
        current
    )
    assert not performance_refresh_needed(store)
    current["positions"][0]["current_price"] = 30
    assert not performance_refresh_needed(store)


def test_embedded_live_lane_recovers_claim_and_rechecks_change_after_main_finishes(
    tmp_path, monkeypatch
):
    import sqlite3
    import threading
    import time

    from trading_max.application import StageRegistry, StageResult
    from trading_max.application.research_stages import TypedPublishSnapshotStage
    from trading_max.infrastructure import SqliteJobQueue

    from services.api.trading_max_api import typed_jobs
    from services.api.trading_max_api.artifacts import ArtifactStore
    from services.api.trading_max_api.watchlist import WatchlistStore

    fetching_export = threading.Event()
    release_export = threading.Event()
    retry_claim = threading.Event()
    claim_failed = threading.Event()
    kill_live_lane = threading.Event()

    claim = SqliteJobQueue.claim

    def claim_with_failures(self, worker_id, **kwargs):
        if worker_id.endswith("-live"):
            if kill_live_lane.is_set():
                raise sqlite3.OperationalError("no such table")
            if retry_claim.is_set():
                retry_claim.clear()
                claim_failed.set()
                raise sqlite3.OperationalError("database is locked")
        return claim(self, worker_id, **kwargs)

    class BrokerStage:
        name = "synthetic.broker"
        version = "v1"
        dependencies = ()
        required_for = frozenset({"accounts", "intraday"})

        def __init__(self, artifacts):
            self.artifacts = artifacts

        def run(self, context):
            live = context.scope == "intraday"
            first_reconciliation = context.trigger == "reconciliation"
            # The reconciliation begins with the old structure, before the live observation.
            quantity = 1 if first_reconciliation else 2
            fetched_at = (
                "2026-11-23T15:00:00Z"
                if first_reconciliation
                else "2026-11-23T15:20:00Z"
                if live
                else "2026-11-23T15:21:00Z"
            )
            account = {
                "fetched_at": fetched_at,
                "cash_gbp": 10,
                "positions": [
                    {"ticker": "BE", "quantity": quantity, "total_cost_gbp": 10 * quantity}
                ],
            }
            if first_reconciliation:
                fetching_export.set()
                assert release_export.wait(timeout=10)
            if live:
                account["positions_status"] = "verified"
            key = (
                "account/intraday/broker_values.json"
                if live
                else "account/broker_snapshot_metrics.json"
            )
            ref = self.artifacts.put_json(key=key, payload={"accounts": {"A": account}}).ref
            return StageResult(artifacts=(ref,))

    class FakeRuntime:
        def __init__(self, _root, **_kwargs):
            snapshots = store.immutable_snapshots
            self.stages = StageRegistry(
                [
                    BrokerStage(snapshots.artifacts),
                    TypedPublishSnapshotStage(snapshots.artifacts, snapshots),
                ]
            )

        def registry(self):
            return self.stages

    def wait_until(predicate):
        deadline = time.monotonic() + 10
        while not predicate():
            assert time.monotonic() < deadline
            threading.Event().wait(0.02)

    store = ArtifactStore(tmp_path)
    monkeypatch.setattr("trading_max.application.TypedWorkerRuntime", FakeRuntime)
    monkeypatch.setattr(SqliteJobQueue, "claim", claim_with_failures)
    monkeypatch.setattr(
        typed_jobs,
        "stage_plan",
        lambda *_args, **_kwargs: [
            ("synthetic.broker", "Collect"),
            ("snapshot.publish", "Publish"),
        ],
    )
    manager = typed_jobs.TypedJobManager(
        store, WatchlistStore(tmp_path), embedded_worker=True, worker_poll_seconds=0.05
    )

    try:
        reconciliation = manager.submit("accounts", trigger="reconciliation", skip_sync=False)
        assert fetching_export.wait(timeout=5)
        retry_claim.set()
        live = manager.submit("live", skip_sync=False)
        assert claim_failed.wait(timeout=5)
        wait_until(lambda: manager.get(live.job_id).status == "succeeded")
        assert manager.get(reconciliation.job_id).status == "running"
        assert manager.worker_health()["healthy"] is True
        assert set(manager.queue.pending_account_checks()) == {"A"}
        assert [job.job_id for job in manager.queue.active_records()] == [reconciliation.job_id]

        # No later live slot is needed to reconcile the trade first seen by live.
        release_export.set()
        wait_until(
            lambda: any(
                job.trigger == "performance" and job.status == "succeeded" for job in manager.list()
            )
        )
        assert manager.get(reconciliation.job_id).status == "succeeded"
        assert len([job for job in manager.list() if job.trigger == "performance"]) == 1
        assert manager.queue.pending_account_checks() == {}
        assert not manager.performance_refresh_needed()

        kill_live_lane.set()
        wait_until(lambda: manager.worker_health()["live_status"] == "stopped")
        health = manager.worker_health()
        assert health["status"] == "idle"
        assert health["healthy"] is False
    finally:
        release_export.set()
        manager.close()


def test_verified_trade_survives_summary_slots_and_failed_follow_up_restarts(tmp_path, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from trading_max.application import StageResult
    from trading_max.infrastructure import job_queue
    from trading_max.worker import LIVE_LANE_TRIGGERS

    from services.api.trading_max_api.artifacts import ArtifactStore
    from services.api.trading_max_api.typed_jobs import TypedJobManager, process_account_check
    from services.api.trading_max_api.watchlist import WatchlistStore

    now = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(job_queue, "_now", lambda: now)
    store = ArtifactStore(tmp_path)
    snapshots = store.immutable_snapshots
    artifacts = snapshots.artifacts
    watchlist = WatchlistStore(tmp_path)
    previous = {
        "fetched_at": now.isoformat(),
        "cash_gbp": 10,
        "positions": [{"ticker": "BE", "quantity": 1, "total_cost_gbp": 10}],
    }
    canonical = artifacts.put_json(
        key="account/broker_snapshot_metrics.json", payload={"accounts": {"A": previous}}
    ).ref
    snapshots.publish(scope="accounts", source="seed", artifacts=[canonical])

    class SyntheticLive:
        name = "synthetic.trade"
        version = "v1"
        dependencies = ()
        required_for = frozenset({"intraday"})

        def run(self, context):
            account = {
                "fetched_at": now.isoformat(),
                "cash_gbp": 10,
                "positions_status": "unreconciled" if self.summary_only else "verified",
            }
            if not self.summary_only:
                account["positions"] = [{"ticker": "BE", "quantity": 2, "total_cost_gbp": 20}]
            live = artifacts.put_json(
                key="account/intraday/broker_values.json", payload={"accounts": {"A": account}}
            ).ref
            snapshot = snapshots.publish(
                scope="intraday", source=context.job_id, artifacts=[canonical, live]
            )
            return StageResult(
                artifacts=(live,), metadata={"snapshot_run_id": snapshot.manifest.run_id}
            )

    manager = TypedJobManager(store, watchlist)
    queue = manager.queue
    stage = SyntheticLive()
    manager.registry.register(stage)
    live_worker = manager._build_worker(
        worker_id="fixture-live", lease_seconds=60, allowed_triggers=LIVE_LANE_TRIGGERS
    )
    try:
        reconciliation = queue.enqueue("accounts", trigger="reconciliation")
        queue.claim("fixture-main", lease_seconds=3600)
        for summary_only in (False, True):
            stage.summary_only = summary_only
            now += timedelta(minutes=10)
            queue.enqueue("live", trigger="live", stages=[("synthetic.trade", "v1")])
            assert live_worker.run_once()
        assert not performance_refresh_needed(store)
        assert queue.pending_account_checks()["A"].observed_at == now - timedelta(minutes=10)
        queue.complete(
            reconciliation.job_id,
            "fixture-main",
            snapshot_run_id="stale-reconciliation",
            account_evidence={
                "A": job_queue.AccountEvidence(now - timedelta(minutes=20), canonical.artifact_id)
            },
        )
    finally:
        live_worker.close()
        manager.close()

    with_restart = TypedJobManager(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    try:
        queue = with_restart.queue
        process_account_check(queue, with_restart.registry, with_restart.store)
        jobs = [job for job in queue.active_records() if job.trigger == "performance"]
        assert len(jobs) == 1
        first_request = jobs[0].job_id
        for _ in range(3):
            claimed = queue.claim("fixture-main")
            assert claimed.record.job_id == first_request
            failed = queue.fail(
                first_request,
                "fixture-main",
                error_code="broker.sync_failed",
                error_message="synthetic export failure",
                retryable=True,
            )
        assert failed.status == "failed"
        assert queue.pending_account_checks() == {}
    finally:
        with_restart.close()

    # The automatic request failed and the process stopped. A summary-only
    # slot supplies no new position evidence to make it eligible again.
    restarted = TypedJobManager(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    queue = restarted.queue
    restarted.registry.register(stage)
    live_worker = restarted._build_worker(
        worker_id="restarted-live", lease_seconds=60, allowed_triggers=LIVE_LANE_TRIGGERS
    )
    try:
        now += timedelta(seconds=29)
        queue.enqueue("live", trigger="live", stages=[("synthetic.trade", "v1")])
        assert live_worker.run_once()
        process_account_check(queue, restarted.registry, restarted.store)
        assert not queue.active_records()

        now += timedelta(seconds=1)
        process_account_check(queue, restarted.registry, restarted.store)
        jobs = [job for job in queue.active_records() if job.trigger == "performance"]
        assert len(jobs) == 1
        assert jobs[0].job_id != first_request
        assert queue.get(first_request).status == "failed"
    finally:
        live_worker.close()
        restarted.close()
