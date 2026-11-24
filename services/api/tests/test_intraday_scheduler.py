from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.intraday_scheduler import IntradayScheduler
from services.api.trading_max_api.typed_jobs import TypedJobManager
from services.api.trading_max_api.watchlist import WatchlistStore


def _manager(tmp_path: Path) -> TypedJobManager:
    return TypedJobManager(
        ArtifactStore(tmp_path),
        WatchlistStore(tmp_path),
    )


def test_scheduler_submits_exactly_one_job_per_current_slot(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    now = datetime(2026, 8, 7, 14, 20, 12, tzinfo=UTC)
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="06:00",
        window_end="23:00",
        weekdays=(1, 2, 3, 4, 5),
        now=lambda: now,
    )
    try:
        scheduler._tick()
        scheduler._tick()
        jobs = [job for job in manager.list(100) if job.trigger == "intraday"]
        assert len(jobs) == 1
        assert jobs[0].scheduled_for == datetime(2026, 8, 7, 14, 20, tzinfo=UTC)
        assert scheduler.status().next_run_at == datetime(2026, 8, 7, 14, 30, tzinfo=UTC)
    finally:
        scheduler.close()
        manager.close()


def test_scheduler_does_not_replay_a_weekend_or_missed_window(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    now = datetime(2026, 8, 8, 14, 20, tzinfo=UTC)  # Saturday
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="06:00",
        window_end="23:00",
        weekdays=(1, 2, 3, 4, 5),
        now=lambda: now,
    )
    try:
        scheduler._tick()
        assert not [job for job in manager.list(100) if job.trigger == "intraday"]
        assert scheduler.status().next_run_at == datetime(2026, 8, 10, 5, 0, tzinfo=UTC)
    finally:
        scheduler.close()
        manager.close()


def test_scheduler_runs_on_weekends_with_the_24_7_production_schedule(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    now = datetime(2026, 8, 8, 14, 20, 12, tzinfo=UTC)  # Saturday
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        now=lambda: now,
    )
    try:
        scheduler._tick()
        jobs = [job for job in manager.list(100) if job.trigger == "intraday"]
        assert len(jobs) == 1
        assert jobs[0].scheduled_for == datetime(2026, 8, 8, 14, 20, tzinfo=UTC)
        assert scheduler.status().next_run_at == datetime(2026, 8, 8, 14, 30, tzinfo=UTC)
    finally:
        scheduler.close()
        manager.close()


def test_performance_scheduler_submits_lightweight_half_hour_job(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=1800,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        scope="performance",
        trigger="performance",
        performance=True,
        now=lambda: datetime(2026, 8, 8, 14, 20, tzinfo=UTC),
    )
    try:
        scheduler._tick()
        jobs = [job for job in manager.list(100) if job.trigger == "performance"]
        assert len(jobs) == 1
        assert jobs[0].scope == "performance"
        assert jobs[0].skip_sync is True
        assert [stage.name for stage in jobs[0].stages] == [
            "accounts.snapshot",
            "accounts.nav",
            "accounts.performance",
            "snapshot.publish",
        ]
        assert scheduler.status().material_change_triggered is False
    finally:
        scheduler.close()
        manager.close()


def test_live_job_is_admitted_and_claimed_ahead_of_scheduled_performance(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    try:
        performance = manager.submit(
            "performance",
            skip_sync=True,
            trigger="performance",
        )
        live = manager.submit("live", skip_sync=False, trigger="live")
        worker_id = "live-priority-worker"
        manager.queue.register_worker(worker_id, worker_version="test")
        claimed = manager.queue.claim(worker_id)
        assert claimed is not None
        assert claimed.record.job_id == live.job_id
        manager.queue.cancel_running(live.job_id, worker_id)
        manager.queue.unregister_worker(worker_id)
        manager.cancel(performance.job_id)
    finally:
        manager.close()


def test_live_scheduler_keeps_the_slot_when_performance_was_submitted_first(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    now = datetime(2026, 9, 16, 19, 30, tzinfo=UTC)
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        scope="live",
        trigger="live",
        now=lambda: now,
    )
    try:
        manager.submit("performance", skip_sync=True, trigger="performance", scheduled_for=now)
        scheduler._tick()
        scheduler._tick()
        live = [job for job in manager.list(100) if job.trigger == "live"]
        assert len(live) == 1
        assert live[0].scheduled_for == now
        assert live[0].skip_sync is False
        assert scheduler.status().next_run_at == now + timedelta(minutes=10)
    finally:
        scheduler.close()
        manager.close()


def test_busy_scheduler_retries_current_slot_without_replaying_old_slots(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    now = datetime(2026, 9, 16, 19, 30, tzinfo=UTC)
    scheduler = IntradayScheduler(
        manager,
        enabled=True,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        scope="live",
        trigger="live",
        now=lambda: now,
    )
    try:
        active_live = manager.submit(
            "live",
            skip_sync=False,
            trigger="live",
            scheduled_for=datetime(2026, 9, 16, 19, 20, tzinfo=UTC),
        )
        assert scheduler._tick() == 30
        assert scheduler.status().next_run_at == now + timedelta(seconds=30)
        manager.cancel(active_live.job_id)
        now += timedelta(seconds=30)
        scheduler._tick()
        first = next(
            job
            for job in manager.list(100)
            if job.trigger == "live" and job.job_id != active_live.job_id
        )
        assert first.scheduled_for == datetime(2026, 9, 16, 19, 30, tzinfo=UTC)

        now = datetime(2026, 9, 16, 19, 40, tzinfo=UTC)
        assert scheduler._tick() == 30
        manager.cancel(first.job_id)
        now = datetime(2026, 9, 16, 19, 51, tzinfo=UTC)
        scheduler._tick()
        slots = {
            job.scheduled_for
            for job in manager.list(100)
            if job.trigger == "live" and job.job_id != active_live.job_id
        }
        assert slots == {
            datetime(2026, 9, 16, 19, 30, tzinfo=UTC),
            datetime(2026, 9, 16, 19, 50, tzinfo=UTC),
        }
    finally:
        scheduler.close()
        manager.close()


def test_full_refresh_does_not_block_intraday_lane_and_unrestricted_claim_prioritizes_full(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    try:
        reconciliation = manager.submit("accounts", skip_sync=False, trigger="reconciliation")
        slot = datetime(2026, 8, 7, 14, 20, tzinfo=UTC)
        scheduler = IntradayScheduler(
            manager,
            enabled=True,
            timezone="Europe/London",
            interval_seconds=600,
            window_start="06:00",
            window_end="23:00",
            weekdays=(1, 2, 3, 4, 5),
            scope="live",
            trigger="live",
            now=lambda: slot,
        )
        scheduler._tick()
        live_jobs = [job for job in manager.list(100) if job.trigger == "live"]
        assert len(live_jobs) == 1
        assert live_jobs[0].scheduled_for == slot
        scheduler.close()
        manager.cancel(live_jobs[0].job_id)
        manager.cancel(reconciliation.job_id)

        intraday = manager.submit("intraday", skip_sync=False)
        # An unrestricted worker still claims a full job ahead of an intraday job.
        later_full = manager.submit("accounts", skip_sync=True)
        assert later_full.trigger == "on_demand"
        worker_id = "priority-test-worker"
        manager.queue.register_worker(worker_id, worker_version="test")
        claimed = manager.queue.claim(worker_id)
        assert claimed is not None
        assert claimed.record.job_id == later_full.job_id
        assert claimed.record.trigger == "on_demand"
        manager.queue.cancel_running(claimed.record.job_id, worker_id)
        manager.queue.unregister_worker(worker_id)
        assert intraday.trigger == "intraday"
    finally:
        manager.close()


def test_schedule_status_observes_terminal_transition_of_same_job(tmp_path):
    manager = _manager(tmp_path)
    scheduler = IntradayScheduler(
        manager,
        enabled=False,
        timezone="Europe/London",
        interval_seconds=600,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
    )
    try:
        job = manager.submit("intraday", skip_sync=False)
        assert scheduler.status().consecutive_failures == 0
        manager.cancel(job.job_id, reason="synthetic interruption")
        failed = scheduler.status()
        assert failed.consecutive_failures == 1
        assert failed.last_error == "synthetic interruption"
        assert scheduler.status().consecutive_failures == 1
    finally:
        scheduler.close()
        manager.close()


def test_worker_main_runs_live_lane_in_parallel_with_main_lane_and_shares_registry(
    tmp_path: Path, monkeypatch
) -> None:
    import threading

    from trading_max.application import StageRegistry, StageResult
    from trading_max.domain import JobStatus as DomainJobStatus

    from services.api.trading_max_api import worker_main
    from services.api.trading_max_api.config import Settings

    main_entered = threading.Event()
    release_main = threading.Event()
    live_done = threading.Event()
    coordinator_errors: list[Exception] = []
    stop_callback: list = []
    stage_instances: list[object] = []

    class _BlockingMainStage:
        name = "synthetic.main"
        version = "v1"
        required_for = frozenset({"accounts"})
        dependencies: tuple[str, ...] = ()

        def run(self, _context):
            main_entered.set()
            assert release_main.wait(timeout=5)
            return StageResult()

    class _FastLiveStage:
        name = "synthetic.live"
        version = "v1"
        required_for = frozenset({"intraday"})
        dependencies: tuple[str, ...] = ()

        def run(self, _context):
            stage_instances.append(self)
            return StageResult()

    fake_registry = StageRegistry([_BlockingMainStage(), _FastLiveStage()])

    class _FakeRuntime:
        def __init__(self, *_args, **_kwargs):
            pass

        def registry(self) -> StageRegistry:
            return fake_registry

    monkeypatch.setenv("TRADING_MAX_WORKER_ID", "worker-lane-test")
    monkeypatch.setattr("trading_max.application.TypedWorkerRuntime", _FakeRuntime)
    monkeypatch.setattr(
        worker_main.signal,
        "signal",
        lambda _sig, handler: stop_callback.append(handler),
    )

    manager = _manager(tmp_path)
    try:
        main_job = manager.queue.enqueue(
            "accounts",
            trigger="reconciliation",
            skip_sync=False,
            stages=[("synthetic.main", "v1")],
        )
        live_job = manager.queue.enqueue(
            "live",
            trigger="live",
            skip_sync=False,
            stages=[("synthetic.live", "v1")],
        )

        def coordinate() -> None:
            try:
                assert main_entered.wait(timeout=5)
                # Live must publish while the reconciliation is still blocked.
                deadline = datetime.now(UTC) + timedelta(seconds=5)
                while datetime.now(UTC) < deadline:
                    if manager.queue.get(live_job.job_id).status == DomainJobStatus.SUCCEEDED:
                        live_done.set()
                        break
                    live_done.wait(0.02)
                assert live_done.is_set()
                assert manager.queue.get(main_job.job_id).status == DomainJobStatus.RUNNING
                assert manager.queue.worker_health()["worker_id"] == "worker-lane-test"
                assert len(manager.queue.active_records()) == 1
                release_main.set()
                while datetime.now(UTC) < deadline:
                    if manager.queue.get(main_job.job_id).status == DomainJobStatus.SUCCEEDED:
                        break
                    threading.Event().wait(0.02)
            except Exception as exc:
                coordinator_errors.append(exc)
            finally:
                release_main.set()
                stop_callback[0](None, None)

        coordinator = threading.Thread(target=coordinate, daemon=True)
        coordinator.start()
        worker_main._run_typed_worker(
            Settings(
                data_root=tmp_path,
                worker_poll_seconds=0.05,
                llm_analysis_enabled=False,
                llm_provider="fake",
            )
        )
        coordinator.join(timeout=5)
        assert not coordinator.is_alive()
        assert not coordinator_errors
        assert live_done.is_set()
        assert manager.queue.get(main_job.job_id).status == DomainJobStatus.SUCCEEDED
        assert manager.queue.get(live_job.job_id).status == DomainJobStatus.SUCCEEDED
        assert len(stage_instances) == 1
    finally:
        manager.close()


def test_embedded_shutdown_interrupts_export_and_live_waits(tmp_path, monkeypatch) -> None:
    import threading
    import time

    from trading_max.application import StageRegistry
    from trading_max.application.broker_stages import BrokerSyncStage
    from trading_max.application.broker_sync import Trading212BrokerSync
    from trading_max.ingestion.brokers.trading212 import (
        ManagedAccountStore,
        Trading212Client,
        Trading212Credentials,
    )

    from services.api.trading_max_api import typed_jobs

    export_waiting = threading.Event()
    live_waiting = threading.Event()
    store = ArtifactStore(tmp_path)
    broker_root = tmp_path / "trading212"

    class WaitingBroker(Trading212Client):
        def snapshot(self, *, include_pending_orders=False):
            if threading.current_thread().name.endswith("-live"):
                live_waiting.set()
                self._sleep(65)
                raise AssertionError("live wait did not stop")
            return {
                "fetched_at_utc": "2026-11-23T15:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": "0",
                    "cash": {"availableToTrade": "0", "reservedForOrders": "0", "inPies": "0"},
                    "investments": {
                        "currentValue": "0",
                        "totalCost": "0",
                        "realizedProfitLoss": "0",
                        "unrealizedProfitLoss": "0",
                    },
                },
                "positions": [],
            }

        def cash_transactions(self, **_kwargs):
            return []

        def request_export(self, _start, _end):
            return 17

        def list_exports(self):
            export_waiting.set()
            return [{"reportId": 17, "status": "Processing"}]

    class SyntheticRuntime:
        def __init__(self, _root, *, stop_event, **_kwargs):
            self.sync = Trading212BrokerSync(
                credentials_factory=lambda profile: Trading212Credentials(
                    profile=profile, api_key="synthetic-key", api_secret="synthetic-secret"
                ),
                store_factory=lambda profile: ManagedAccountStore(profile, data_root=broker_root),
                stop_event=stop_event,
            )

        def registry(self):
            return StageRegistry(
                [
                    BrokerSyncStage(
                        tmp_path, store.immutable_artifacts, sync=self.sync, profiles=("invest",)
                    )
                ]
            )

    monkeypatch.setattr("trading_max.application.TypedWorkerRuntime", SyntheticRuntime)
    monkeypatch.setattr("trading_max.application.broker_sync.Trading212Client", WaitingBroker)
    monkeypatch.setattr(
        typed_jobs, "stage_plan", lambda *_args, **_kwargs: [("broker.sync", "Sync")]
    )

    manager = TypedJobManager(
        store, WatchlistStore(tmp_path), embedded_worker=True, worker_poll_seconds=0.05
    )
    inspector = _manager(tmp_path)
    try:
        main = manager.submit("accounts", trigger="reconciliation", skip_sync=False)
        live = manager.submit("live", skip_sync=False)
        assert export_waiting.wait(timeout=5), inspector.get(main.job_id).error
        assert live_waiting.wait(timeout=5)
        assert inspector.get(main.job_id).status == "running"
        assert inspector.get(live.job_id).status == "running"

        started = time.monotonic()
        assert manager.close()
        assert time.monotonic() - started < 2.5
        for job_id in (main.job_id, live.job_id):
            result = inspector.get(job_id)
            assert result.status == "queued"
            assert result.stages[0].status == "queued"
        assert (broker_root / "invest" / "pending_export.json").is_file()
    finally:
        manager.close()
        inspector.close()
