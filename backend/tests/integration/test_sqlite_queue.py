import json
from pathlib import Path
from shutil import copy2
from threading import Thread

from trading_max.application import StageRegistry, StageResult
from trading_max.domain import ArtifactRef, StageStatus
from trading_max.infrastructure import SqliteDatabase, SqliteJobQueue
from trading_max.worker import DurableWorker, StageExecutionError

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def make_queue(tmp_path: Path) -> SqliteJobQueue:
    return SqliteJobQueue(SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS))


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


def test_workers_can_claim_disjoint_trigger_lanes(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", trigger="system", job_id="analysis-job")
    queue.enqueue("intraday", trigger="intraday", job_id="interactive-job")

    refresh = queue.claim(
        "refresh-worker",
        allowed_triggers=("on_demand", "nightly", "intraday"),
    )
    analysis = queue.claim(
        "analysis-worker",
        allowed_triggers=("system",),
    )

    assert refresh is not None
    assert refresh.record.job_id == "interactive-job"
    assert analysis is not None
    assert analysis.record.job_id == "analysis-job"


def test_worker_trigger_lane_does_not_claim_other_work(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.enqueue("research", trigger="system", stages=[("demo", "1")])
    worker = DurableWorker(
        queue,
        StageRegistry([_Stage()]),
        worker_id="refresh-only",
        allowed_triggers=("on_demand", "nightly", "intraday"),
    )

    assert worker.run_once() is False
    assert queue.list()[0].status == "queued"
    worker.close()


def test_worker_health_prefers_the_interactive_lane(tmp_path: Path) -> None:
    queue = make_queue(tmp_path)
    queue.register_worker("worker-main", worker_version="test")
    queue.heartbeat_worker("worker-main", status="idle")
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
    assert [row["version"] for row in versions] == [
        "0001_initial.sql",
        "0002_queue_metadata.sql",
        "0003_job_cancellation.sql",
        "0004_worker_heartbeat.sql",
        "0005_stage_cache.sql",
        "0006_analysis_state.sql",
        "0007_intraday_jobs.sql",
        "0008_settings_profile_integrations.sql",
        "0009_llm_provider_routing.sql",
        "0010_analysis_route_provenance.sql",
        "0011_analysis_adapter_provenance.sql",
        "0012_analysis_lens_identity.sql",
        "0013_cfd_account_label.sql",
        "0014_automation_preferences.sql",
        "0015_cfd_job_scope.sql",
        "0016_three_scope_automation.sql",
        "0017_three_scope_jobs.sql",
    ]
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
