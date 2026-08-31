from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier, Thread

from trading_max.infrastructure import SqliteDatabase

from services.api.trading_max_api.analysis_repository import (
    MIGRATIONS,
    AnalysisRunRepository,
)
from services.api.trading_max_api.models import AnalysisRunRecord, AnalysisStatus


def _record() -> AnalysisRunRecord:
    return AnalysisRunRecord(
        run_id="analysis-1",
        snapshot_run_id="snapshot-1",
        status=AnalysisStatus.QUEUED,
        lenses=["daily_cio_brief"],
        provider="fake",
        model="fake-v1",
        created_at=datetime(2026, 8, 7, tzinfo=UTC),
    )


def test_analysis_repository_round_trips_run_and_latest_pointer(tmp_path: Path) -> None:
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    repository = AnalysisRunRepository(database)
    record = _record()
    repository.save(record)

    loaded = repository.get(record.run_id)
    assert loaded == record

    repository.set_latest(
        snapshot_run_id="snapshot-1",
        lens="daily_cio_brief",
        ticker=None,
        artifact_id="a" * 64,
        input_hash="input-1",
        updated_at=datetime(2026, 8, 7, 12, tzinfo=UTC),
    )
    assert (
        repository.latest_id(
            snapshot_run_id="snapshot-1",
            lens="daily_cio_brief",
            ticker=None,
        )
        == "a" * 64
    )
    database.close()


def test_analysis_repository_upsert_and_list_are_deterministic(tmp_path: Path) -> None:
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    repository = AnalysisRunRepository(database)
    record = _record()
    repository.save(record)
    record.status = AnalysisStatus.SUCCEEDED
    record.artifact_ids = ["b" * 64]
    repository.save(record)

    assert repository.get("analysis-1").status == "succeeded"
    assert repository.list(limit=1)[0].artifact_ids == ["b" * 64]
    database.close()


def test_analysis_repository_reads_legacy_page_identity(tmp_path: Path) -> None:
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    repository = AnalysisRunRepository(database)
    record = _record()
    repository.save(record)
    with database.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE analysis_runs SET lenses_json = '[]', pages_json = '[\"overview\"]' "
            "WHERE run_id = ?",
            (record.run_id,),
        )
        connection.execute(
            "INSERT INTO analysis_latest("
            "snapshot_run_id, page, ticker, artifact_id, input_hash, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            (
                "legacy-snapshot",
                "overview",
                "PORTFOLIO",
                "c" * 64,
                "legacy-input",
                datetime(2026, 8, 7, 12, tzinfo=UTC).isoformat(),
            ),
        )

    assert repository.get(record.run_id).lenses == ["daily_cio_brief"]
    assert (
        repository.latest_id(
            snapshot_run_id="legacy-snapshot",
            lens="daily_cio_brief",
            ticker=None,
        )
        == "c" * 64
    )
    database.close()


def test_analysis_repository_recovers_running_but_not_queued_runs(tmp_path: Path) -> None:
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    repository = AnalysisRunRepository(database)
    queued = _record()
    running = _record().model_copy(
        update={"run_id": "analysis-2", "status": AnalysisStatus.RUNNING}
    )
    succeeded = _record().model_copy(
        update={"run_id": "analysis-3", "status": AnalysisStatus.SUCCEEDED}
    )
    for record in (queued, running, succeeded):
        repository.save(record)

    assert repository.recover_interrupted(message="worker restarted") == 1
    assert repository.get("analysis-1").status == AnalysisStatus.QUEUED
    assert repository.get("analysis-2").status == AnalysisStatus.INTERRUPTED
    assert repository.get("analysis-3").status == AnalysisStatus.SUCCEEDED
    assert "worker restarted" in repository.get("analysis-2").errors
    database.close()


def test_analysis_repository_serializes_concurrent_upserts(tmp_path: Path) -> None:
    database = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    repository = AnalysisRunRepository(database)
    barrier = Barrier(2)
    errors: list[Exception] = []

    def save(run_id: str) -> None:
        try:
            barrier.wait(timeout=5)
            repository.save(_record().model_copy(update={"run_id": run_id}))
        except Exception as exc:  # pragma: no cover - assertion below reports it
            errors.append(exc)

    threads = [Thread(target=save, args=(f"analysis-{index}",)) for index in (4, 5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert errors == []
    assert {item.run_id for item in repository.list(10)} >= {"analysis-4", "analysis-5"}
    database.close()
