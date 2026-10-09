"""Persisted overview warnings must survive fresh valuations and API restarts."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.typed_jobs import TypedJobManager
from services.api.trading_max_api.watchlist import WatchlistStore

NOW = datetime(2026, 10, 9, 12, tzinfo=UTC)


@pytest.fixture
def manager(tmp_path: Path):
    jobs = TypedJobManager(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    yield jobs
    jobs.close()


def record(jobs, scope, status, minutes_ago, *, skip_sync=False, cancelled=False):
    at = (NOW - timedelta(minutes=minutes_ago)).isoformat()
    job = jobs.queue.enqueue(scope, skip_sync=skip_sync)
    with jobs.queue.database.transaction() as connection:
        connection.execute(
            "UPDATE jobs SET status=?, created_at=?, finished_at=?, cancel_requested=? "
            "WHERE job_id=?",
            (status, at, at, int(cancelled), job.job_id),
        )


def test_live_updates_and_performance_success_do_not_clear_full_sync_failures(
    manager, tmp_path: Path, monkeypatch
):
    record(manager, "all", "succeeded", 120)
    for minutes in (90, 60, 30):
        record(manager, "accounts", "failed", minutes)
    record(manager, "performance", "succeeded", 20, skip_sync=True)
    record(manager, "research", "succeeded", 10)
    record(manager, "accounts", "interrupted", 5, cancelled=True)
    record(manager, "accounts", "running", 0)
    # An arbitrarily long run of live jobs must not truncate the failure history.
    with manager.queue.database.transaction() as connection:
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at) "
            "VALUES (?, 'live', 'live', 'succeeded', ?)",
            [(f"live-{i}", NOW.isoformat()) for i in range(5_010)],
        )
    # Opening another manager models a restarted API: no in-memory failure counter.
    restarted = TypedJobManager(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    try:

        def no_records(*_args):
            raise AssertionError("overview must not load job details or logs")

        monkeypatch.setattr(restarted.queue, "_record", no_records)
        attention = restarted.refresh_attention(now=NOW)
        assert len(attention.issues) == 1
        assert attention.issues[0].scope == "accounts"
        assert attention.issues[0].consecutive_failures == 3
        assert attention.issues[0].failing_since == NOW - timedelta(minutes=90)
    finally:
        restarted.close()


@pytest.mark.parametrize(
    ("ages", "warns"),
    [([], False), ([900], False), ([29, 1], False), ([30, 1], True), ([3, 2, 1], True)],
)
def test_only_repeated_failures_cross_the_attention_threshold(manager, ages, warns):
    for age in ages:
        record(manager, "performance", "failed", age, skip_sync=True)
    assert bool(manager.refresh_attention(now=NOW).issues) is warns


def test_failures_are_tracked_independently_and_full_recovery_clears_both(manager):
    for age in (90, 60, 30):
        record(manager, "accounts", "failed", age)
        record(manager, "performance", "failed", age - 1, skip_sync=True)
    assert {issue.scope for issue in manager.refresh_attention(now=NOW).issues} == {
        "accounts",
        "performance",
    }
    # Rebuilding from cached data is not evidence that broker history recovered.
    record(manager, "accounts", "succeeded", 20, skip_sync=True)
    assert [issue.scope for issue in manager.refresh_attention(now=NOW).issues] == ["accounts"]
    record(manager, "all", "succeeded", 10)
    assert manager.refresh_attention(now=NOW).issues == []
    record(manager, "accounts", "failed", 5)
    assert manager.refresh_attention(now=NOW).issues == []


def test_cancellations_research_and_queued_jobs_never_create_warnings(manager):
    for age in (90, 60, 30):
        record(manager, "accounts", "interrupted", age, cancelled=True)
        record(manager, "research", "failed", age - 1)
        record(manager, "accounts", "queued", age - 2)
    assert manager.refresh_attention(now=NOW).issues == []


def test_read_only_endpoint_returns_bounded_status_without_snapshot_or_errors(tmp_path: Path):
    app = create_app(Settings(data_root=tmp_path, api_token="synthetic"))
    with TestClient(app) as client:
        assert client.get("/v1/refresh-attention").json()["issues"] == []
        for age in (90, 60, 30):
            record(app.state.jobs, "accounts", "failed", age)
        response = client.get("/v1/refresh-attention")
        assert response.status_code == 200
        payload = response.json()
        assert set(payload) == {"checkedAt", "issues"}
        assert payload["issues"] == [
            {
                "scope": "accounts",
                "consecutiveFailures": 3,
                "failingSince": (NOW - timedelta(minutes=90)).isoformat().replace("+00:00", "Z"),
            }
        ]
        assert len(response.content) < 300
