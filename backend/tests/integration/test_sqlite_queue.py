import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from shutil import copy2
from threading import Thread

import pytest
from trading_max.application import StageRegistry, StageResult
from trading_max.domain import ArtifactRef, JobStatus, StageStatus
from trading_max.infrastructure import SqliteDatabase, SqliteJobQueue
from trading_max.infrastructure.job_queue import QueueConflict
from trading_max.worker import (
    ANALYSIS_LANE_TRIGGERS,
    LIVE_LANE_TRIGGERS,
    MAIN_LANE_TRIGGERS,
    DurableWorker,
    StageExecutionError,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def make_queue(tmp_path: Path) -> SqliteJobQueue:
    return SqliteJobQueue(SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS))


def test_scheduler_queries_find_old_active_and_scheduled_jobs_beyond_history_limit(
    tmp_path: Path,
) -> None:
    queue = make_queue(tmp_path)
    slot = datetime(2026, 9, 16, 18, 30, tzinfo=UTC)
    old = (slot - timedelta(days=1)).isoformat(timespec="microseconds")
    with queue.database.transaction() as connection:
        connection.execute(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at, scheduled_for) "
            "VALUES ('old-active', 'all', 'nightly', 'queued', ?, ?)",
            (old, slot.isoformat(timespec="microseconds")),
        )
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at) "
            "VALUES (?, 'live', 'live', 'succeeded', ?)",
            [(f"finished-{index}", slot.isoformat()) for index in range(5_010)],
        )
    try:
        assert [job.job_id for job in queue.active_records()] == ["old-active"]
        latest = queue.latest_for_triggers(("nightly", "research", "reconciliation"))
        assert latest is not None and latest.job_id == "old-active"
        attempt = queue.scheduled_attempt(("nightly",), slot)
        assert attempt is not None and attempt.job_id == "old-active"
        assert queue.scheduled_attempt(("nightly",), slot + timedelta(minutes=1)) is None
        assert queue.scheduled_attempt(("research",), slot) is None

        with queue.database.transaction() as connection:
            connection.execute("UPDATE jobs SET scheduled_for = NULL WHERE job_id = 'old-active'")
        legacy = queue.scheduled_attempt(("nightly",), datetime.fromisoformat(old))
        assert legacy is not None and legacy.job_id == "old-active"
    finally:
        queue.database.close()


class _Stage:
    name = "demo"
    version = "1"
    required_for = frozenset({"research"})

    def run(self, context):
        return StageResult(metadata={"job_id": context.job_id})


def test_queue_claim_lease_heartbeat_and_complete(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queued = queue.enqueue("research", stages=[("demo", "1")], job_id="job-1")
    assert queued.status == "queued"

    claimed = queue.claim("worker-a", lease_seconds=60)
    assert claimed is not None
    assert claimed.record.status == "running"
    assert claimed.record.attempts == 1
    queue.heartbeat("job-1", "worker-a", lease_seconds=60)
    queue.set_stage("job-1", "worker-a", "demo", StageStatus.RUNNING)
    queue.set_stage("job-1", "worker-a", "demo", StageStatus.SUCCEEDED)
    complete = queue.complete("job-1", "worker-a", snapshot_run_id="snapshot-1")
    assert complete.status == "succeeded"
    assert complete.snapshot_run_id == "snapshot-1"
    assert complete.stages[0].status == StageStatus.SUCCEEDED
    health = queue.queue_health()
    assert health["succeeded"] == 1
    assert health["queued"] == 0


def test_queue_persists_stage_idempotency_and_cache_metadata(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", stages=[("demo", "1")], job_id="job-cache")
    assert queue.claim("worker-cache", lease_seconds=60) is not None

    key = "b" * 64
    artifact_id = "a" * 64
    queue.set_stage(
        "job-cache",
        "worker-cache",
        "demo",
        StageStatus.RUNNING,
        idempotency_key=key,
    )
    queue.set_stage(
        "job-cache",
        "worker-cache",
        "demo",
        StageStatus.SUCCEEDED,
        artifact_ids=[artifact_id],
        idempotency_key=key,
    )
    queue.cache_stage_result(
        idempotency_key=key,
        stage_name="demo",
        stage_version="1",
        artifact_ids=[artifact_id],
    )

    record = queue.get("job-cache")
    assert record.stages[0].idempotency_key == key
    assert queue.cached_stage_artifacts(
        idempotency_key=key,
        stage_name="demo",
        stage_version="1",
    ) == [artifact_id]


def test_expired_lease_can_be_reclaimed_by_another_worker(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("accounts", job_id="job-2")
    assert queue.claim("worker-a", lease_seconds=0) is not None
    reclaimed = queue.claim("worker-b", lease_seconds=60)
    assert reclaimed is not None
    assert reclaimed.worker_id == "worker-b"
    assert reclaimed.record.attempts == 2


def test_abandoned_cancelled_job_is_finalized_after_lease_expiry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import trading_max.infrastructure.job_queue as queue_module

    now = datetime(2026, 9, 19, 8, tzinfo=UTC)
    monkeypatch.setattr(queue_module, "_now", lambda: now)
    queue = make_queue(tmp_path)
    queue.enqueue("accounts", stages=[("demo", "1")], job_id="abandoned")
    assert queue.claim("stopped-worker", lease_seconds=60) is not None
    queue.set_stage("abandoned", "stopped-worker", "demo", StageStatus.RUNNING)
    queue.cancel("abandoned", reason="synthetic operator cancellation")

    assert queue.claim("replacement-worker") is None
    assert queue.get("abandoned").status == "running"
    assert queue.get("abandoned").cancel_requested

    now += timedelta(seconds=61)
    assert queue.claim("replacement-worker") is None
    cancelled = queue.get("abandoned")
    assert cancelled.status == "interrupted"
    assert cancelled.error_code == "job.cancelled"
    assert cancelled.error_message == "synthetic operator cancellation"
    assert cancelled.finished_at == now
    assert cancelled.lease_expires_at is None
    assert not cancelled.cancel_requested
    assert cancelled.attempts == 1
    assert cancelled.stages[0].status == StageStatus.INTERRUPTED
    assert queue.active_records() == []
    with pytest.raises(QueueConflict):
        queue.heartbeat("abandoned", "stopped-worker")

    queue.enqueue("accounts", job_id="new-refresh")
    claimed = queue.claim("replacement-worker")
    assert claimed is not None and claimed.record.job_id == "new-refresh"


def test_workers_can_claim_disjoint_trigger_lanes(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", trigger="system", job_id="analysis-job")
    queue.enqueue("all", trigger="reconciliation", job_id="main-job")
    queue.enqueue("live", trigger="live", job_id="live-job")

    main = queue.claim(
        "main-worker",
        allowed_triggers=MAIN_LANE_TRIGGERS,
    )
    live = queue.claim(
        "main-worker-live",
        allowed_triggers=LIVE_LANE_TRIGGERS,
    )
    analysis = queue.claim(
        "main-worker-analysis",
        allowed_triggers=ANALYSIS_LANE_TRIGGERS,
    )

    assert main is not None
    assert main.record.job_id == "main-job"
    assert live is not None
    assert live.record.job_id == "live-job"
    assert analysis is not None
    assert analysis.record.job_id == "analysis-job"
    assert queue.claim("main-worker", allowed_triggers=MAIN_LANE_TRIGGERS) is None
    assert queue.claim("main-worker-live", allowed_triggers=LIVE_LANE_TRIGGERS) is None
    assert queue.claim("main-worker-analysis", allowed_triggers=ANALYSIS_LANE_TRIGGERS) is None


def test_worker_trigger_lane_does_not_claim_other_work(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", trigger="system", stages=[("demo", "1")])
    queue.enqueue("live", trigger="live", stages=[("demo", "1")])
    worker = DurableWorker(
        queue,
        StageRegistry([_Stage()]),
        worker_id="main-only",
        allowed_triggers=MAIN_LANE_TRIGGERS,
    )

    assert worker.run_once() is False
    assert all(job.status == "queued" for job in queue.list())
    worker.close()


def test_worker_health_prefers_the_interactive_lane(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.register_worker("worker-main", worker_version="test")
    queue.heartbeat_worker("worker-main", status="idle")
    queue.register_worker("worker-main-live", worker_version="test")
    queue.heartbeat_worker("worker-main-live", status="running", current_job_id="live-tick")
    queue.register_worker("worker-main-analysis", worker_version="test")
    queue.heartbeat_worker("worker-main-analysis", status="running", current_job_id="slow")

    assert queue.worker_health()["worker_id"] == "worker-main"


def test_latest_refreshes_skip_system_and_research_only_jobs(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("accounts", trigger="nightly", job_id="full-refresh")
    queue.enqueue("intraday", trigger="intraday", job_id="intraday-refresh")
    queue.enqueue("research", trigger="on_demand", job_id="research-refresh")
    queue.enqueue("research", trigger="system", job_id="analysis-job")

    full, intraday = queue.latest_refreshes()

    assert full is not None and full.job_id == "full-refresh"
    assert intraday is not None and intraday.job_id == "intraday-refresh"


def test_latest_terminal_job_orders_by_completion_and_excludes_cancellations(
    tmp_path: Path,
) -> None:
    queue = make_queue(tmp_path)
    with queue.database.transaction() as connection:
        connection.executemany(
            "INSERT INTO jobs(job_id, scope, trigger, status, created_at, finished_at) "
            "VALUES (?, 'cfd', 'on_demand', ?, ?, ?)",
            [
                (
                    "slow-failure",
                    "failed",
                    "2026-11-01T00:00:00+00:00",
                    "2026-11-03T00:00:00+00:00",
                ),
                (
                    "quick-success",
                    "succeeded",
                    "2026-11-02T00:00:00+00:00",
                    "2026-11-02T00:00:00+00:00",
                ),
            ],
        )
    queue.cancel(queue.enqueue("cfd", job_id="cancelled-retry").job_id)
    queue.enqueue("research", trigger="system", job_id="internal")
    assert queue.claim("test-worker", allowed_triggers=("system",)) is not None
    queue.complete("internal", "test-worker", snapshot_run_id="synthetic")

    assert [job.job_id for job in queue.latest_terminal_jobs()] == ["slow-failure"]
    queue.database.close()


def test_trigger_summary_returns_latest_and_exact_counts(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("intraday", trigger="intraday", job_id="older")
    queue.enqueue("intraday", trigger="intraday", job_id="newer")
    claimed = queue.claim("worker", allowed_triggers=("intraday",))
    assert claimed is not None

    latest, counts = queue.trigger_summary("intraday")

    assert latest is not None and latest.job_id == "newer"
    assert counts == {"queued": 1, "running": 1}


def test_worker_persists_stage_result_and_job_completion(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", stages=[("demo", "1")], job_id="job-3")
    worker = DurableWorker(
        queue,
        StageRegistry([_Stage()]),
        worker_id="worker-test",
        snapshot_id_factory=lambda _: "snapshot-3",
    )
    assert queue.worker_health() is not None
    assert queue.worker_health()["worker_id"] == "worker-test"
    assert worker.run_once() is True
    assert worker.run_once() is False
    assert queue.get("job-3").snapshot_run_id == "snapshot-3"
    worker.close()
    assert queue.worker_health()["status"] == "stopped"


class _ProducingStage:
    name = "produce"
    version = "1"
    required_for = frozenset({"research"})

    def run(self, context):
        return StageResult(
            artifacts=(
                ArtifactRef(
                    artifact_id="a" * 64,
                    key="research/input.json",
                    sha256="a" * 64,
                ),
            )
        )


class _ConsumingStage:
    name = "consume"
    version = "1"
    required_for = frozenset({"research"})

    def run(self, context):
        assert context.upstream_artifact_ids == ("a" * 64,)
        return StageResult()


class _DependencyStage:
    name = "dependent"
    version = "1"
    required_for = frozenset({"research"})
    dependencies = ("produce",)

    def run(self, context):
        raise AssertionError("dependency validation should happen before run")


def test_worker_rejects_invalid_stage_order(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue(
        "research",
        stages=[("dependent", "1"), ("produce", "1")],
        job_id="job-invalid-order",
    )
    worker = DurableWorker(
        queue,
        StageRegistry([_DependencyStage(), _ProducingStage()]),
        worker_id="worker-invalid-order",
    )

    assert worker.run_once() is True
    record = queue.get("job-invalid-order")
    assert record.status == "failed"
    assert record.error_code == "stage.dependency_invalid"
    worker.close()


class _VersionedStage:
    name = "versioned"
    version = "2"
    required_for = frozenset({"research"})
    dependencies: tuple[str, ...] = ()

    def run(self, context):
        raise AssertionError("version validation should happen before run")


def test_worker_rejects_queued_stage_version_mismatch(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue(
        "research",
        stages=[("versioned", "1")],
        job_id="job-version-mismatch",
    )
    worker = DurableWorker(
        queue,
        StageRegistry([_VersionedStage()]),
        worker_id="worker-version-mismatch",
    )

    assert worker.run_once() is True
    record = queue.get("job-version-mismatch")
    assert record.status == "failed"
    assert record.error_code == "stage.version_mismatch"
    worker.close()


def test_worker_passes_persisted_stage_artifacts_to_downstream_stage(
    tmp_path: Path,
) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue(
        "research",
        stages=[("produce", "1"), ("consume", "1")],
        job_id="job-upstream",
    )
    worker = DurableWorker(
        queue,
        StageRegistry([_ProducingStage(), _ConsumingStage()]),
        worker_id="worker-upstream",
    )

    assert worker.run_once() is True
    assert queue.get("job-upstream").status == "succeeded"
    assert queue.get("job-upstream").stages[1].status == StageStatus.SUCCEEDED
    worker.close()


class _FailingStage:
    name = "fail"
    version = "1"
    required_for = frozenset({"research"})

    def run(self, context):
        raise StageExecutionError("market.timeout", "provider timed out", retryable=True)


def test_retryable_stage_failure_returns_job_to_queue(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", stages=[("fail", "1")], job_id="job-4")
    worker = DurableWorker(
        queue,
        StageRegistry([_FailingStage()]),
        worker_id="worker-test",
    )
    assert worker.run_once() is True
    record = queue.get("job-4")
    assert record.status == "queued"
    assert record.attempts == 1
    assert record.error_code == "market.timeout"


def test_concurrent_database_startup_applies_migrations_once(tmp_path: Path) -> None:
    database_path = tmp_path / "trading_max.db"
    errors: list[Exception] = []

    def start_process(process_id: str) -> None:
        try:
            database = SqliteDatabase(database_path, migrations_dir=MIGRATIONS)
            SqliteJobQueue(database).enqueue("research", job_id=process_id)
            database.close()
        except Exception as exc:
            errors.append(exc)

    threads = [Thread(target=start_process, args=(f"startup-{index}",)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    database = SqliteDatabase(database_path, migrations_dir=MIGRATIONS)
    versions = database.connection.execute(
        "SELECT version FROM schema_migrations ORDER BY version"
    ).fetchall()
    assert [row["version"] for row in versions] == sorted(
        path.name for path in MIGRATIONS.glob("*.sql")
    )
    profile = database.connection.execute(
        "SELECT account_labels_json FROM user_profile WHERE profile_id = 'local'"
    ).fetchone()
    assert json.loads(profile["account_labels_json"])["C"] == "CFD"
    assert len(SqliteJobQueue(database).list()) == 2
    database.close()


def test_intraday_migration_preserves_existing_queue_rows(tmp_path: Path) -> None:
    old_migrations = tmp_path / "old-migrations"
    old_migrations.mkdir()
    for migration in sorted(MIGRATIONS.glob("000[1-6]_*.sql")):
        copy2(migration, old_migrations / migration.name)

    database_path = tmp_path / "trading_max.db"
    old_database = SqliteDatabase(database_path, migrations_dir=old_migrations)
    old_queue = SqliteJobQueue(old_database)
    old_queue.enqueue(
        "research",
        stages=[("demo", "1")],
        job_id="before-intraday-migration",
    )
    old_database.close()

    database = SqliteDatabase(database_path, migrations_dir=MIGRATIONS)
    queue = SqliteJobQueue(database)
    preserved = queue.get("before-intraday-migration")
    assert preserved.scope == "research"
    assert preserved.stages[0].name == "demo"
    intraday = queue.enqueue(
        "intraday",
        trigger="intraday",
        stages=[("broker.sync", "broker-sync-v1")],
        job_id="after-intraday-migration",
    )
    assert intraday.scope == "intraday"
    database.close()


def test_verified_account_checks_survive_restart_until_covered(tmp_path: Path, monkeypatch) -> None:
    from trading_max.infrastructure import job_queue

    now = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(job_queue, "_now", lambda: now)
    queue = make_queue(tmp_path)
    running = queue.enqueue("accounts", trigger="reconciliation")
    queue.claim("main-lane", lease_seconds=3600)

    now += timedelta(minutes=10)
    invest = job_queue.AccountEvidence(now, "verified-invest")
    live = queue.enqueue("live", trigger="live")
    queue.claim("live-lane", allowed_triggers=LIVE_LANE_TRIGGERS)
    queue.complete(
        live.job_id, "live-lane", snapshot_run_id="synthetic-live", account_evidence={"A": invest}
    )
    now += timedelta(minutes=10)
    isa = job_queue.AccountEvidence(now, "verified-isa")
    summary = queue.enqueue("live", trigger="live")
    queue.claim("live-lane", allowed_triggers=LIVE_LANE_TRIGGERS)
    queue.complete(
        summary.job_id,
        "live-lane",
        snapshot_run_id="synthetic-summary",
        account_evidence={"B": isa},
    )
    queue.database.close()

    queue = make_queue(tmp_path)
    checks = {"A": invest, "B": isa}
    assert queue.pending_account_checks() == checks
    with pytest.raises(QueueConflict, match="account check is no longer ready"):
        queue.enqueue("accounts", trigger="performance", account_checks=checks)
    assert queue.pending_account_checks() == checks

    # An earlier reconciliation cannot clear evidence that appeared during its export wait.
    queue.complete(
        running.job_id,
        "main-lane",
        snapshot_run_id="synthetic-reconciliation",
        account_evidence={"A": invest, "B": isa},
    )
    assert queue.pending_account_checks() == checks
    now += timedelta(seconds=1)
    follow_up = queue.enqueue("accounts", trigger="performance", account_checks=checks)
    assert queue.pending_account_checks() == {}
    assert follow_up.status == JobStatus.QUEUED
    with queue.database.read() as connection:
        assert connection.execute("SELECT count(*) FROM pending_account_check").fetchone()[0] == 2

    queue.claim("main-lane")
    queue.complete(
        follow_up.job_id,
        "main-lane",
        snapshot_run_id="synthetic-follow-up",
        account_evidence={"A": invest, "B": isa},
    )
    with queue.database.read() as connection:
        assert connection.execute("SELECT count(*) FROM pending_account_check").fetchone()[0] == 0
    queue.database.close()


@pytest.mark.parametrize("busy_attempts", [1, 4])
def test_published_job_retries_completion_without_republishing(
    tmp_path: Path, monkeypatch, busy_attempts: int
) -> None:
    import sqlite3
    from contextlib import contextmanager

    from trading_max.infrastructure import SnapshotStore, job_queue

    now = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(job_queue, "_now", lambda: now)
    snapshots = SnapshotStore(tmp_path)
    artifact = snapshots.artifacts.put_json(key="fixture.json", payload={"verified": True}).ref
    evidence = {"A": job_queue.AccountEvidence(now, artifact.artifact_id)}
    publications = []
    completion_attempts = []

    class Publish:
        name = "snapshot.publish"
        version = "v1"
        dependencies = ()
        required_for = frozenset({"intraday"})

        def run(self, context):
            stored = snapshots.publish(
                scope=context.scope, source=context.job_id, artifacts=(artifact,)
            )
            run_id = stored.manifest.run_id
            publications.append(run_id)
            return StageResult(artifacts=(artifact,), metadata={"snapshot_run_id": run_id})

    queue = make_queue(tmp_path)
    job = queue.enqueue("live", trigger="live", stages=[("snapshot.publish", "v1")])
    real_transaction = queue.database.transaction

    @contextmanager
    def contend_before_completion_commit(*, immediate=False):
        with real_transaction(immediate=immediate) as connection:
            yield connection
            row = connection.execute(
                "SELECT status, snapshot_run_id FROM jobs WHERE job_id = ?", (job.job_id,)
            ).fetchone()
            if row["status"] == "succeeded" and len(completion_attempts) < busy_attempts:
                completion_attempts.append(row["snapshot_run_id"])
                assert snapshots.latest().manifest.run_id == row["snapshot_run_id"]
                # Contention rolls back both the success transition and this evidence write.
                assert (
                    connection.execute(
                        "SELECT artifact_id FROM pending_account_check WHERE account_code = 'A'"
                    ).fetchone()[0]
                    == artifact.artifact_id
                )
                raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(queue.database, "transaction", contend_before_completion_commit)
    registry = StageRegistry([Publish()])
    worker = DurableWorker(queue, registry, worker_id="first", account_evidence=lambda *_: evidence)
    if busy_attempts == 4:
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            worker.run_once()
        assert queue.get(job.job_id).status == JobStatus.RUNNING
        assert queue.get(job.job_id).snapshot_run_id == publications[0]
        assert queue.pending_account_checks() == {}
        assert queue.cancel(job.job_id).cancel_requested
        now += timedelta(minutes=6)
        worker = DurableWorker(
            queue, registry, worker_id="second", account_evidence=lambda *_: evidence
        )
    assert worker.run_once()
    finished = queue.get(job.job_id)
    assert finished.status == JobStatus.SUCCEEDED
    assert publications == [finished.snapshot_run_id]
    assert completion_attempts == [finished.snapshot_run_id] * busy_attempts
    assert queue.pending_account_checks() == evidence


@pytest.mark.parametrize("cancelled", [False, True])
@pytest.mark.parametrize("recovery", ["intent", "missing_current", "missing", "pruned"])
def test_worker_recovers_visible_intent_after_acknowledgement_is_lost(
    tmp_path: Path, monkeypatch, cancelled: bool, recovery: str
) -> None:
    import sqlite3

    from trading_max.application.research_stages import TypedPublishSnapshotStage
    from trading_max.infrastructure import SnapshotStore, job_queue

    now = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(job_queue, "_now", lambda: now)
    store = SnapshotStore(tmp_path)
    old = store.artifacts.put_json(key="fixture.json", payload={"value": 1})
    new = store.artifacts.put_json(key="fixture.json", payload={"value": 2})
    queue = make_queue(tmp_path)
    job = queue.enqueue(
        "live",
        trigger="live",
        stages=[("fixture.collect", "v1"), ("snapshot.publish", "snapshot-v2")],
    )
    real_set_stage = queue.set_stage

    class Collect:
        name = "fixture.collect"
        version = "v1"
        dependencies = ()
        required_for = frozenset({"intraday"})

        def run(self, _context):
            return StageResult(artifacts=(old.ref,))

    registry = StageRegistry([Collect(), TypedPublishSnapshotStage(store.artifacts, store)])
    expected = {"A": job_queue.AccountEvidence(now, old.ref.artifact_id)}

    def account_evidence(_record, artifact_ids):
        assert artifact_ids == (old.ref.artifact_id,)
        return expected

    def miss_acknowledgement(job_id, worker_id, name, status, **kwargs):
        if name == "snapshot.publish" and status == StageStatus.SUCCEEDED:
            visible = store.latest().manifest.run_id
            assert queue.get(job_id).snapshot_run_id == visible
            if cancelled:
                queue.cancel(job_id)
            raise sqlite3.OperationalError("database is locked")
        real_set_stage(job_id, worker_id, name, status, **kwargs)

    monkeypatch.setattr(queue, "set_stage", miss_acknowledgement)
    worker = DurableWorker(queue, registry, worker_id="first", account_evidence=account_evidence)
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        worker.run_once()
    published = store.latest().manifest.run_id
    assert queue.get(job.job_id).stages[-1].status == StageStatus.RUNNING
    assert queue.pending_account_checks() == {}
    if recovery != "intent":
        # Model the previous WAL durability gap independently of the fsynced pointer.
        with queue.database.transaction(immediate=True) as connection:
            connection.execute(
                "UPDATE jobs SET snapshot_run_id = NULL WHERE job_id = ?", (job.job_id,)
            )
    queue.database.close()

    current = store.latest()
    if recovery != "missing_current":
        # A newer publication replaces the same artifact key before the lease is reclaimed.
        current = SnapshotStore(tmp_path).publish(
            scope="accounts", source="intervening", artifacts=[new]
        )
    if recovery == "pruned":
        from services.api.trading_max_api.artifacts import ArtifactStore

        assert ArtifactStore(tmp_path).prune_snapshots(keep_recent=1, keep_monthly=0) == [published]
        assert not store.was_published(published)
    now += timedelta(minutes=6)
    queue = make_queue(tmp_path)
    replacement = DurableWorker(
        queue, registry, worker_id="replacement", account_evidence=account_evidence
    )
    assert replacement.run_once()
    finished = queue.get(job.job_id)
    assert not finished.cancel_requested
    assert store.latest().manifest == current.manifest
    if recovery == "pruned":
        # Even with no surviving proof, a stale job cannot overwrite the successor.
        assert finished.status == (JobStatus.INTERRUPTED if cancelled else JobStatus.FAILED)
        if not cancelled:
            assert finished.error_code == "snapshot.superseded"
        assert finished.snapshot_run_id is None
        assert queue.pending_account_checks() == {}
        assert len(store.list()) == 1
    else:
        assert finished.status == JobStatus.SUCCEEDED
        assert finished.snapshot_run_id == published
        assert finished.stages[-1].status == StageStatus.SUCCEEDED
        assert queue.pending_account_checks() == expected
        assert len(store.list()) == (1 if recovery == "missing_current" else 2)


@pytest.mark.parametrize("visible", [False, True])
def test_snapshot_swap_decides_whether_cancellation_is_honored(
    tmp_path: Path, monkeypatch, visible: bool
) -> None:
    import sqlite3

    from trading_max.application.research_stages import TypedPublishSnapshotStage
    from trading_max.infrastructure import SnapshotStore, job_queue, snapshots

    now = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(job_queue, "_now", lambda: now)
    store = SnapshotStore(tmp_path)
    artifact = store.artifacts.put_json(key="fixture.json", payload={"verified": True})
    queue = make_queue(tmp_path)
    job = queue.enqueue(
        "live",
        trigger="live",
        stages=[("fixture.collect", "v1"), ("snapshot.publish", "snapshot-v2")],
    )
    evidence = {"A": job_queue.AccountEvidence(now, artifact.ref.artifact_id)}
    sql_trace: list[str] = []
    queue.database.connection.set_trace_callback(sql_trace.append)

    class Collect:
        name = "fixture.collect"
        version = "v1"
        dependencies = ()
        required_for = frozenset({"intraday"})

        def run(self, _context):
            return StageResult(artifacts=(artifact.ref,))

    registry = StageRegistry([Collect(), TypedPublishSnapshotStage(store.artifacts, store)])
    real_write = snapshots._atomic_write

    def cancel_at_swap(path, content):
        if path != store.latest_path:
            real_write(path, content)
            return
        run_id = queue.get(job.job_id).snapshot_run_id
        assert run_id is not None
        full = sql_trace.index("PRAGMA synchronous=FULL")
        committed = sql_trace.index("COMMIT", full)
        assert any(
            "UPDATE jobs SET snapshot_run_id" in statement
            for statement in sql_trace[full:committed]
        )
        assert sql_trace[committed + 1] == "PRAGMA synchronous=1"
        if visible:
            real_write(path, content)
        assert queue.cancel(job.job_id).cancel_requested
        if not visible:
            raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(snapshots, "_atomic_write", cancel_at_swap)
    worker = DurableWorker(queue, registry, worker_id="first", account_evidence=lambda *_: evidence)
    if visible:
        assert worker.run_once()
        finished = queue.get(job.job_id)
        assert finished.status == JobStatus.SUCCEEDED
        assert finished.snapshot_run_id == store.latest().manifest.run_id
        assert queue.pending_account_checks() == evidence
    else:
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            worker.run_once()
        assert store.latest() is None
        assert store.list() == []
        assert not (store.snapshots_root / queue.get(job.job_id).snapshot_run_id).exists()
        now += timedelta(minutes=6)
        replacement = DurableWorker(
            queue, registry, worker_id="replacement", account_evidence=lambda *_: evidence
        )
        assert replacement.run_once()
        finished = queue.get(job.job_id)
        assert finished.status == JobStatus.INTERRUPTED
        assert finished.snapshot_run_id is None
        assert queue.pending_account_checks() == {}
    assert not finished.cancel_requested
