from __future__ import annotations

from datetime import UTC, datetime
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


def test_full_refresh_blocks_intraday_and_queue_claim_prioritizes_full(
    tmp_path: Path,
) -> None:
    manager = _manager(tmp_path)
    try:
        full = manager.submit("research", skip_sync=True, tickers=["BE"])
        scheduler = IntradayScheduler(
            manager,
            enabled=True,
            timezone="Europe/London",
            interval_seconds=600,
            window_start="06:00",
            window_end="23:00",
            weekdays=(1, 2, 3, 4, 5),
            now=lambda: datetime(2026, 8, 7, 14, 20, tzinfo=UTC),
        )
        scheduler._tick()
        assert not [job for job in manager.list(100) if job.trigger == "intraday"]
        scheduler.close()
        manager.cancel(full.job_id)

        intraday = manager.submit("intraday", skip_sync=False)
        # A full job admitted after an intraday job must still be claimed first.
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
