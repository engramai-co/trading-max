from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.infrastructure import SqliteDatabase, SqliteJobQueue

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def make_queue(tmp_path: Path) -> SqliteJobQueue:
    return SqliteJobQueue(SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS))


def test_outcomes_group_recent_failures_by_cause_and_ignore_cancellations(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    now = datetime(2026, 11, 3, 12, tzinfo=UTC)
    old = (now - timedelta(days=8)).isoformat(timespec="microseconds")
    recent = [
        (now - timedelta(hours=hours)).isoformat(timespec="microseconds") for hours in range(6)
    ]
    rows = [
        ("old-failure", "live", "live", "failed", old, 0, "broker.sync_failed", "old"),
        ("ok-1", "live", "live", "succeeded", recent[5], 0, None, None),
        ("ok-2", "all", "nightly", "succeeded", recent[4], 0, None, None),
        ("sync-1", "live", "live", "failed", recent[3], 0, "broker.intraday_snapshot_failed", "a"),
        ("sync-2", "live", "live", "failed", recent[2], 0, "broker.intraday_snapshot_failed", "b"),
        ("full", "all", "nightly", "failed", recent[1], 0, "broker.sync_failed", "mismatch"),
        ("stopped", "all", "on_demand", "failed", recent[0], 1, "job.cancelled", "operator"),
        ("lost", "research", "research", "interrupted", recent[0], 0, None, None),
        ("system", "all", "system", "failed", recent[0], 0, "x", "internal"),
    ]
    with queue.database.transaction() as connection:
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at, finished_at, "
            "cancel_requested, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(*row[:5], row[4], *row[5:]) for row in rows],
        )
    try:
        summary = queue.outcomes(now - timedelta(days=7))
        assert summary["totals"] == {"succeeded": 2, "failed": 3, "interrupted": 1, "cancelled": 1}
        assert summary["scopes"]["live"] == {
            "succeeded": 1,
            "failed": 2,
            "interrupted": 0,
            "cancelled": 0,
        }
        causes = [(c["error_code"], c["scope"], c["count"]) for c in summary["causes"]]
        assert causes == [
            ("broker.intraday_snapshot_failed", "live", 2),
            ("broker.sync_failed", "all", 1),
            ("job.interrupted", "research", 1),
        ]
        assert summary["causes"][0]["last_message"] == "b"
    finally:
        queue.database.close()
