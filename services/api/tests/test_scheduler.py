from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.scheduler import NightlyScheduler
from services.api.trading_max_api.typed_jobs import TypedJobManager
from services.api.trading_max_api.watchlist import WatchlistStore


def test_missed_full_refresh_slot_is_submitted_once(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    jobs = TypedJobManager(store, WatchlistStore(tmp_path / "runtime"))
    fixed_now = datetime(2026, 8, 2, 7, 15, tzinfo=UTC)
    scheduler = NightlyScheduler(
        jobs,
        enabled=True,
        timezone="Europe/London",
        local_times=("06:30", "12:00", "17:30", "22:30"),
        now=lambda: fixed_now,
    )
    try:
        assert scheduler.status().next_run_at == fixed_now
        scheduler._tick()
        nightly = [job for job in jobs.list() if job.trigger == "nightly"]
        assert len(nightly) == 1
        assert nightly[0].scope == "all"
        assert "research.technical" in [stage.name for stage in nightly[0].stages]
        assert nightly[0].scheduled_for is not None
        assert scheduler.status().next_run_at == datetime(2026, 8, 2, 11, 0, tzinfo=UTC)
        assert scheduler.status().local_times == ["06:30", "12:00", "17:30", "22:30"]

        scheduler._tick()
        assert len([job for job in jobs.list() if job.trigger == "nightly"]) == 1
    finally:
        scheduler.close()
        jobs.close()


def test_scheduler_submits_only_the_latest_missed_slot_without_replaying_backlog(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    jobs = TypedJobManager(store, WatchlistStore(tmp_path / "runtime"))
    fixed_now = datetime(2026, 8, 2, 18, 0, tzinfo=UTC)
    scheduler = NightlyScheduler(
        jobs,
        enabled=True,
        timezone="Europe/London",
        local_times=("06:30", "12:00", "17:30", "22:30"),
        now=lambda: fixed_now,
    )
    try:
        scheduler._tick()
        nightly = [job for job in jobs.list() if job.trigger == "nightly"]
        assert len(nightly) == 1
        assert nightly[0].scheduled_for == datetime(2026, 8, 2, 16, 30, tzinfo=UTC)
        assert scheduler.status().next_run_at == datetime(2026, 8, 2, 21, 30, tzinfo=UTC)

        scheduler._tick()
        assert len([job for job in jobs.list() if job.trigger == "nightly"]) == 1
    finally:
        scheduler.close()
        jobs.close()


def test_research_scheduler_coalesces_last_slot_into_daily_reconciliation(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    jobs = TypedJobManager(store, WatchlistStore(tmp_path / "runtime"))
    now = datetime(2026, 8, 2, 22, 0, tzinfo=UTC)  # 23:00 London
    scheduler = NightlyScheduler(
        jobs,
        enabled=True,
        timezone="Europe/London",
        local_times=("06:30", "12:00", "17:30", "22:30"),
        reconciliation_local_time="22:30",
        now=lambda: now,
    )
    try:
        scheduler._tick()
        scheduled = jobs.list()
        assert len(scheduled) == 1
        assert scheduled[0].scope == "all"
        assert scheduled[0].trigger == "reconciliation"
        assert scheduled[0].skip_sync is False
    finally:
        scheduler.close()
        jobs.close()
