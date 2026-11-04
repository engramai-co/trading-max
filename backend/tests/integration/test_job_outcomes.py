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


def test_outcomes_separate_causes_that_share_an_error_code(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    now = datetime(2026, 11, 3, 12, tzinfo=UTC)
    stamps = [
        (now - timedelta(hours=hours)).isoformat(timespec="microseconds") for hours in range(5)
    ]
    network = "invest: Trading 212 request failed: GET /equity/account/summary (ConnectError)"
    limited = "isa: Trading 212 returned HTTP 429: too many requests"
    mismatch = (
        "invest: broker snapshot reconciliation failed: {...}; position_tolerance_gbp=1.429285"
    )
    code = "broker.intraday_snapshot_failed"
    rows = [
        ("n-1", "live", "live", "failed", stamps[4], code, network),
        ("n-2", "live", "live", "failed", stamps[3], code, network),
        ("r-1", "live", "live", "failed", stamps[2], code, limited),
        (
            "m-1",
            "performance",
            "performance",
            "failed",
            stamps[1],
            "account.snapshot_invalid",
            mismatch,
        ),
        ("o-1", "research", "research", "failed", stamps[0], "market.snapshot_failed", "no OHLCV"),
    ]
    with queue.database.transaction() as connection:
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at, finished_at, "
            "error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(*row[:5], row[4], *row[5:]) for row in rows],
        )
    try:
        causes = {
            (c["error_code"], c["kind"]): (c["count"], c["last_message"])
            for c in queue.outcomes(now - timedelta(days=7))["causes"]
        }
        assert causes == {
            (code, "network"): (2, network),
            (code, "rate_limit"): (1, limited),
            ("account.snapshot_invalid", "reconciliation"): (1, mismatch),
            ("market.snapshot_failed", None): (1, "no OHLCV"),
        }
    finally:
        queue.database.close()


def test_outcomes_count_the_successes_after_each_cause_last_failed(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    now = datetime(2026, 11, 3, 12, tzinfo=UTC)
    stamps = [(now - timedelta(minutes=minutes)) for minutes in range(0, 80, 10)]
    iso = [stamp.isoformat(timespec="microseconds") for stamp in stamps]
    code = "broker.intraday_snapshot_failed"
    network = "invest: Trading 212 request failed (ConnectError)"
    limited = "isa: Trading 212 returned HTTP 429: too many requests"
    mismatch = "invest: broker snapshot reconciliation failed: {...}"
    rows = [
        ("n-1", "live", "failed", iso[7], 0, code, network),
        ("ok-1", "live", "succeeded", iso[6], 0, None, None),
        ("ok-2", "live", "succeeded", iso[5], 0, None, None),
        ("p-1", "performance", "failed", iso[4], 0, "account.snapshot_invalid", mismatch),
        ("r-1", "live", "failed", iso[3], 0, code, limited),
        ("n-2", "live", "failed", iso[2], 0, code, network),
        ("ok-3", "live", "succeeded", iso[1], 0, None, None),
        ("stop", "live", "failed", iso[0], 1, "job.cancelled", "operator"),
    ]
    with queue.database.transaction() as connection:
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at, finished_at, "
            "cancel_requested, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(job, scope, scope, *rest[:2], *rest[1:]) for job, scope, *rest in rows],
        )
    try:
        causes = {
            (c["scope"], c["kind"]): (c["count"], c["succeeded_after"], c["last_success_at"])
            for c in queue.outcomes(now - timedelta(days=7))["causes"]
        }
        assert causes == {
            # The repeat at n-2 restarts the count; the cancellation is not a success.
            ("live", "network"): (2, 1, stamps[1]),
            # Another cause failing in the same scope does not reset this one.
            ("live", "rate_limit"): (1, 1, stamps[1]),
            ("performance", "reconciliation"): (1, 0, None),
        }
    finally:
        queue.database.close()
