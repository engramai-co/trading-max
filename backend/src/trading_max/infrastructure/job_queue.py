"""Durable job queue backed by the same SQLite database as application state."""

from __future__ import annotations

import json
import os
import secrets
import socket
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from trading_max.domain.contracts import (
    JobRecord,
    JobScope,
    JobStageRecord,
    JobStatus,
    StageStatus,
)

from .sqlite import SqliteDatabase


class QueueConflict(RuntimeError):
    """The requested queue transition is not valid for the current owner."""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


@dataclass(frozen=True, slots=True)
class ClaimedJob:
    record: JobRecord
    worker_id: str


class SqliteJobQueue:
    """A lease-based queue safe for separate API and worker processes."""

    def __init__(self, database: SqliteDatabase) -> None:
        self.database = database

    def enqueue(
        self,
        scope: JobScope,
        *,
        trigger: Literal[
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
            "system",
        ] = "on_demand",
        skip_sync: bool = False,
        tickers: list[str] | None = None,
        stages: Sequence[tuple[str, str] | tuple[str, str, str]] = (),
        scheduled_for: datetime | None = None,
        log_path: str | None = None,
        job_id: str | None = None,
    ) -> JobRecord:
        created = _now()
        record = JobRecord(
            job_id=job_id or secrets.token_hex(16),
            scope=scope,
            trigger=trigger,
            skip_sync=skip_sync,
            tickers=list(dict.fromkeys(tickers or [])),
            created_at=created,
            scheduled_for=scheduled_for,
            log_path=log_path,
            stages=[
                JobStageRecord(
                    name=stage[0],
                    version=stage[1],
                    label=stage[2] if len(stage) == 3 else stage[0],
                )
                for stage in stages
            ],
        )
        with self.database.transaction(immediate=True) as connection:
            try:
                connection.execute(
                    "INSERT INTO jobs(job_id, scope, trigger, skip_sync, tickers_json, "
                    "status, attempts, created_at, scheduled_for, log_path) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.job_id,
                        record.scope,
                        record.trigger,
                        int(record.skip_sync),
                        json.dumps(record.tickers),
                        record.status,
                        record.attempts,
                        _iso(record.created_at),
                        _iso(record.scheduled_for) if record.scheduled_for else None,
                        record.log_path,
                    ),
                )
                connection.executemany(
                    "INSERT INTO job_stages(job_id, name, version, label, status) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [
                        (
                            record.job_id,
                            stage.name,
                            stage.version,
                            stage.label,
                            stage.status,
                        )
                        for stage in record.stages
                    ],
                )
            except Exception as exc:
                if "UNIQUE constraint failed: jobs.job_id" in str(exc):
                    raise QueueConflict(f"job already exists: {record.job_id}") from exc
                raise
        return record

    def get(self, job_id: str) -> JobRecord:
        with self.database.read() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"job not found: {job_id}")
            return self._record(row, connection)

    def list(self, limit: int = 20, *, include_system: bool = True) -> list[JobRecord]:
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT * FROM jobs WHERE (? = 1 OR trigger != 'system') "
                "ORDER BY created_at DESC LIMIT ?",
                (int(include_system), max(1, min(limit, 5_000))),
            ).fetchall()
            return [self._record(row, connection) for row in rows]

    def latest_refreshes(self) -> tuple[JobRecord | None, JobRecord | None]:
        """Read the two refresh-state anchors without materializing job history."""

        with self.database.read() as connection:
            full_row = connection.execute(
                "SELECT * FROM jobs WHERE scope IN ('all', 'accounts', 'performance') "
                "AND trigger IN ('on_demand', 'nightly', 'performance', 'reconciliation') "
                "ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            intraday_row = connection.execute(
                "SELECT * FROM jobs WHERE trigger IN ('intraday', 'live') "
                "ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            return (
                self._record(full_row, connection) if full_row is not None else None,
                self._record(intraday_row, connection) if intraday_row is not None else None,
            )

    def trigger_summary(
        self,
        trigger: str,
    ) -> tuple[JobRecord | None, dict[str, int]]:
        """Return one trigger's latest job and exact status counts in one read."""

        if trigger not in {
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
            "system",
        }:
            raise ValueError(f"invalid job trigger: {trigger}")
        with self.database.read() as connection:
            latest_row = connection.execute(
                "SELECT * FROM jobs WHERE trigger = ? ORDER BY created_at DESC LIMIT 1",
                (trigger,),
            ).fetchone()
            counts = {
                row["status"]: int(row["count"])
                for row in connection.execute(
                    "SELECT status, COUNT(*) AS count FROM jobs WHERE trigger = ? GROUP BY status",
                    (trigger,),
                ).fetchall()
            }
            return (
                self._record(latest_row, connection) if latest_row is not None else None,
                counts,
            )

    def active_job_id(self) -> str | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT job_id FROM jobs WHERE status IN ('queued', 'running') "
                "AND trigger != 'system' ORDER BY CASE WHEN trigger IN "
                "('on_demand', 'nightly', 'performance', 'research', 'reconciliation') "
                "THEN 0 ELSE 1 END, created_at LIMIT 1"
            ).fetchone()
            return row["job_id"] if row is not None else None

    def queue_health(self) -> dict[str, Any]:
        """Return small, read-only queue metrics for readiness probes."""

        with self.database.read() as connection:
            counts = {
                row["status"]: int(row["count"])
                for row in connection.execute(
                    "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status"
                ).fetchall()
            }
            latest = connection.execute(
                "SELECT MAX(finished_at) AS finished_at FROM jobs WHERE status = 'succeeded'"
            ).fetchone()
        return {
            "queued": counts.get("queued", 0),
            "running": counts.get("running", 0),
            "succeeded": counts.get("succeeded", 0),
            "failed": counts.get("failed", 0),
            "interrupted": counts.get("interrupted", 0),
            "last_success_at": _parse(latest["finished_at"] if latest else None),
        }

    def register_worker(
        self,
        worker_id: str,
        *,
        worker_version: str,
        pid: int | None = None,
        host: str | None = None,
    ) -> None:
        """Register a worker process without exposing any credentials."""

        now = _iso(_now())
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO worker_heartbeats "
                "(worker_id, status, started_at, last_seen_at, "
                "worker_version, pid, host) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(worker_id) DO UPDATE SET status = excluded.status, "
                "started_at = excluded.started_at, last_seen_at = excluded.last_seen_at, "
                "current_job_id = NULL, worker_version = excluded.worker_version, "
                "pid = excluded.pid, host = excluded.host",
                (
                    worker_id,
                    "starting",
                    now,
                    now,
                    worker_version,
                    pid if pid is not None else os.getpid(),
                    host or socket.gethostname(),
                ),
            )

    def heartbeat_worker(
        self,
        worker_id: str,
        *,
        status: str,
        current_job_id: str | None = None,
    ) -> None:
        if status not in {"starting", "idle", "running", "stopping", "stopped"}:
            raise ValueError(f"invalid worker status: {status}")
        with self.database.transaction(immediate=True) as connection:
            result = connection.execute(
                "UPDATE worker_heartbeats SET status = ?, last_seen_at = ?, "
                "current_job_id = ? WHERE worker_id = ?",
                (status, _iso(_now()), current_job_id, worker_id),
            )
            if result.rowcount != 1:
                raise QueueConflict(f"worker is not registered: {worker_id}")

    def unregister_worker(self, worker_id: str) -> None:
        try:
            self.heartbeat_worker(worker_id, status="stopped")
        except QueueConflict:
            # A process may fail before registration is visible. Shutdown must
            # remain best-effort and must never mask the original error.
            return

    def worker_health(self, *, max_age_seconds: int = 120) -> dict[str, Any] | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM worker_heartbeats "
                "ORDER BY CASE WHEN worker_id LIKE '%-analysis' THEN 1 ELSE 0 END, "
                "last_seen_at DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return None
        last_seen = _parse(row["last_seen_at"])
        age_seconds = (
            max(0.0, (_now() - last_seen).total_seconds()) if last_seen is not None else None
        )
        return {
            "worker_id": row["worker_id"],
            "status": row["status"],
            "started_at": _parse(row["started_at"]),
            "last_seen_at": last_seen,
            "current_job_id": row["current_job_id"],
            "worker_version": row["worker_version"],
            "pid": row["pid"],
            "host": row["host"],
            "age_seconds": age_seconds,
            "healthy": (
                row["status"] in {"starting", "idle", "running"}
                and age_seconds is not None
                and age_seconds <= max_age_seconds
            ),
        }

    def cancel(self, job_id: str, *, reason: str = "cancelled by operator") -> JobRecord:
        """Cancel a queued job or request cancellation at the next stage boundary."""

        now = _iso(_now())
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT status FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"job not found: {job_id}")
            if row["status"] == JobStatus.QUEUED:
                connection.execute(
                    "UPDATE jobs SET status = ?, finished_at = ?, "
                    "error_code = ?, error_message = ?, cancel_requested = 0 "
                    "WHERE job_id = ?",
                    (
                        JobStatus.INTERRUPTED,
                        now,
                        "job.cancelled",
                        reason,
                        job_id,
                    ),
                )
            elif row["status"] == JobStatus.RUNNING:
                connection.execute(
                    "UPDATE jobs SET cancel_requested = 1, error_code = ?, "
                    "error_message = ? WHERE job_id = ?",
                    ("job.cancel_requested", reason, job_id),
                )
            connection.execute(
                "INSERT INTO job_events(job_id, created_at, event_type, payload_json) "
                "VALUES (?, ?, ?, ?)",
                (
                    job_id,
                    now,
                    "cancel_requested",
                    json.dumps({"reason": reason}),
                ),
            )
        return self.get(job_id)

    def cancellation_requested(self, job_id: str, worker_id: str) -> bool:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT cancel_requested, status, worker_id FROM jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if row is None or row["status"] != JobStatus.RUNNING:
                return True
            return bool(row["cancel_requested"] and row["worker_id"] == worker_id)

    def cancel_running(self, job_id: str, worker_id: str) -> JobRecord:
        return self._finish(
            job_id,
            worker_id,
            status=JobStatus.INTERRUPTED,
            error_code="job.cancelled",
            error_message="job cancelled at a stage boundary",
        )

    def request_research_follow_up(
        self,
        job_id: str,
        *,
        tickers: list[str],
    ) -> None:
        """Persist a coalesced research refresh request on an active job."""

        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT status, tickers_json FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"job not found: {job_id}")
            if row["status"] not in {JobStatus.QUEUED, JobStatus.RUNNING}:
                raise QueueConflict(f"job is no longer active: {job_id}")
            merged_tickers = list(dict.fromkeys([*json.loads(row["tickers_json"]), *tickers]))
            connection.execute(
                "UPDATE jobs SET follow_up_research = 1, tickers_json = ? WHERE job_id = ?",
                (json.dumps(merged_tickers), job_id),
            )
            connection.execute(
                "INSERT INTO job_events(job_id, created_at, event_type, payload_json) "
                "VALUES (?, ?, ?, ?)",
                (
                    job_id,
                    _iso(_now()),
                    "follow_up_requested",
                    json.dumps({"scope": "research", "tickers": tickers}),
                ),
            )

    def consume_follow_up(self, job_id: str) -> list[str] | None:
        """Atomically consume a coalesced follow-up request after completion."""

        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT follow_up_research, tickers_json FROM jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if row is None or not row["follow_up_research"]:
                return None
            connection.execute(
                "UPDATE jobs SET follow_up_research = 0 WHERE job_id = ?",
                (job_id,),
            )
            return json.loads(row["tickers_json"])

    def claim(
        self,
        worker_id: str,
        *,
        lease_seconds: int = 300,
        allowed_triggers: Sequence[str] | None = None,
    ) -> ClaimedJob | None:
        now = _now()
        expires = now + timedelta(seconds=lease_seconds)
        trigger_filter = tuple(dict.fromkeys(allowed_triggers or ()))
        invalid_triggers = set(trigger_filter) - {
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
            "system",
        }
        if invalid_triggers:
            raise ValueError(f"invalid job triggers: {sorted(invalid_triggers)}")
        if allowed_triggers is not None and not trigger_filter:
            return None
        restrict_triggers = int(allowed_triggers is not None)
        enabled = set(trigger_filter)
        parameters: tuple[object, ...] = (
            _iso(now),
            restrict_triggers,
            *(
                int(trigger in enabled)
                for trigger in (
                    "on_demand",
                    "nightly",
                    "intraday",
                    "live",
                    "performance",
                    "research",
                    "reconciliation",
                    "system",
                )
            ),
        )
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE (status = 'queued' OR "
                "(status = 'running' AND lease_expires_at < ?)) "
                "AND cancel_requested = 0 "
                "AND (? = 0 "
                "OR (trigger = 'on_demand' AND ? = 1) "
                "OR (trigger = 'nightly' AND ? = 1) "
                "OR (trigger = 'intraday' AND ? = 1) "
                "OR (trigger = 'live' AND ? = 1) "
                "OR (trigger = 'performance' AND ? = 1) "
                "OR (trigger = 'research' AND ? = 1) "
                "OR (trigger = 'reconciliation' AND ? = 1) "
                "OR (trigger = 'system' AND ? = 1)) "
                "ORDER BY CASE "
                "WHEN trigger IN ('on_demand', 'nightly', 'reconciliation') THEN 0 "
                "WHEN trigger IN ('intraday', 'live') THEN 1 "
                "WHEN trigger IN ('performance', 'research') THEN 2 "
                "ELSE 3 END, created_at LIMIT 1",
                parameters,
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE jobs SET status = ?, attempts = attempts + 1, "
                "started_at = COALESCE(started_at, ?), lease_expires_at = ?, "
                "worker_id = ?, error_code = NULL, error_message = NULL "
                "WHERE job_id = ?",
                (
                    JobStatus.RUNNING,
                    _iso(now),
                    _iso(expires),
                    worker_id,
                    row["job_id"],
                ),
            )
            connection.execute(
                "INSERT INTO job_events(job_id, created_at, event_type, payload_json) "
                "VALUES (?, ?, ?, ?)",
                (row["job_id"], _iso(now), "claimed", json.dumps({"worker_id": worker_id})),
            )
            claimed = connection.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (row["job_id"],)
            ).fetchone()
        if claimed is None:
            raise QueueConflict("job disappeared while claiming it")
        with self.database.read() as connection:
            return ClaimedJob(self._record(claimed, connection), worker_id)

    def heartbeat(self, job_id: str, worker_id: str, *, lease_seconds: int = 300) -> None:
        expires = _now() + timedelta(seconds=lease_seconds)
        with self.database.transaction(immediate=True) as connection:
            result = connection.execute(
                "UPDATE jobs SET lease_expires_at = ? WHERE job_id = ? "
                "AND status = 'running' AND worker_id = ?",
                (_iso(expires), job_id, worker_id),
            )
            if result.rowcount != 1:
                raise QueueConflict(f"worker does not own running job: {job_id}")

    def complete(self, job_id: str, worker_id: str, *, snapshot_run_id: str) -> JobRecord:
        return self._finish(
            job_id,
            worker_id,
            status=JobStatus.SUCCEEDED,
            snapshot_run_id=snapshot_run_id,
        )

    def fail(
        self,
        job_id: str,
        worker_id: str,
        *,
        error_code: str,
        error_message: str,
        return_code: int | None = None,
        retryable: bool = False,
        max_attempts: int = 3,
    ) -> JobRecord:
        current = self.get(job_id)
        if current.cancel_requested:
            return self._finish(
                job_id,
                worker_id,
                status=JobStatus.INTERRUPTED,
                error_code="job.cancelled",
                error_message=current.error_message or "job cancelled",
            )
        if retryable and current.attempts < max_attempts:
            with self.database.transaction(immediate=True) as connection:
                self._assert_owner(connection, job_id, worker_id)
                connection.execute(
                    "UPDATE jobs SET status = 'queued', lease_expires_at = NULL, "
                    "worker_id = NULL, error_code = ?, error_message = ?, "
                    "finished_at = NULL WHERE job_id = ?",
                    (error_code, error_message, job_id),
                )
            return self.get(job_id)
        return self._finish(
            job_id,
            worker_id,
            status=JobStatus.FAILED,
            error_code=error_code,
            error_message=error_message,
            return_code=return_code,
        )

    def set_stage(
        self,
        job_id: str,
        worker_id: str,
        stage_name: str,
        status: StageStatus,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        return_code: int | None = None,
        artifact_ids: list[str] | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        now = _iso(_now())
        with self.database.transaction(immediate=True) as connection:
            self._assert_owner(connection, job_id, worker_id)
            if status == StageStatus.RUNNING:
                connection.execute(
                    "UPDATE job_stages SET status = ?, attempt = attempt + 1, "
                    "started_at = COALESCE(started_at, ?), "
                    "idempotency_key = COALESCE(?, idempotency_key) "
                    "WHERE job_id = ? AND name = ?",
                    (status, now, idempotency_key, job_id, stage_name),
                )
            else:
                connection.execute(
                    "UPDATE job_stages SET status = ?, finished_at = ?, "
                    "error_code = ?, error_message = ?, return_code = ?, "
                    "artifact_ids_json = ?, "
                    "idempotency_key = COALESCE(?, idempotency_key) "
                    "WHERE job_id = ? AND name = ?",
                    (
                        status,
                        now,
                        error_code,
                        error_message,
                        return_code,
                        json.dumps(artifact_ids or []),
                        idempotency_key,
                        job_id,
                        stage_name,
                    ),
                )

    def cached_stage_artifacts(
        self,
        *,
        idempotency_key: str,
        stage_name: str,
        stage_version: str,
    ) -> list[str] | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT artifact_ids_json FROM stage_cache "
                "WHERE idempotency_key = ? AND stage_name = ? AND stage_version = ?",
                (idempotency_key, stage_name, stage_version),
            ).fetchone()
            if row is None:
                return None
            return list(json.loads(row["artifact_ids_json"]))

    def cache_stage_result(
        self,
        *,
        idempotency_key: str,
        stage_name: str,
        stage_version: str,
        artifact_ids: list[str],
    ) -> None:
        now = _iso(_now())
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO stage_cache("
                "idempotency_key, stage_name, stage_version, artifact_ids_json, "
                "created_at, last_used_at"
                ") VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(idempotency_key) DO UPDATE SET "
                "stage_name = excluded.stage_name, "
                "stage_version = excluded.stage_version, "
                "artifact_ids_json = excluded.artifact_ids_json, "
                "last_used_at = excluded.last_used_at",
                (
                    idempotency_key,
                    stage_name,
                    stage_version,
                    json.dumps(artifact_ids),
                    now,
                    now,
                ),
            )

    def _finish(self, job_id: str, worker_id: str, **values: Any) -> JobRecord:
        now = _iso(_now())
        status = values["status"]
        with self.database.transaction(immediate=True) as connection:
            self._assert_owner(connection, job_id, worker_id)
            connection.execute(
                "UPDATE jobs SET status = ?, finished_at = ?, lease_expires_at = NULL, "
                "worker_id = NULL, snapshot_run_id = ?, error_code = ?, error_message = ?, "
                "cancel_requested = 0 WHERE job_id = ?",
                (
                    status,
                    now,
                    values.get("snapshot_run_id"),
                    values.get("error_code"),
                    values.get("error_message"),
                    job_id,
                ),
            )
        return self.get(job_id)

    @staticmethod
    def _assert_owner(connection: Any, job_id: str, worker_id: str) -> None:
        row = connection.execute(
            "SELECT status, worker_id FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None or row["status"] != JobStatus.RUNNING or row["worker_id"] != worker_id:
            raise QueueConflict(f"worker does not own running job: {job_id}")

    def _record(self, row: Any, connection: Any) -> JobRecord:
        stages = connection.execute(
            "SELECT * FROM job_stages WHERE job_id = ? ORDER BY rowid",
            (row["job_id"],),
        ).fetchall()
        return JobRecord(
            job_id=row["job_id"],
            scope=row["scope"],
            trigger=row["trigger"],
            skip_sync=bool(row["skip_sync"]),
            tickers=json.loads(row["tickers_json"]),
            status=row["status"],
            attempts=row["attempts"],
            created_at=_parse(row["created_at"]),
            scheduled_for=_parse(row["scheduled_for"]),
            started_at=_parse(row["started_at"]),
            finished_at=_parse(row["finished_at"]),
            lease_expires_at=_parse(row["lease_expires_at"]),
            log_path=row["log_path"],
            cancel_requested=bool(row["cancel_requested"]),
            snapshot_run_id=row["snapshot_run_id"],
            error_code=row["error_code"],
            error_message=row["error_message"],
            stages=[
                JobStageRecord(
                    name=stage["name"],
                    version=stage["version"],
                    label=stage["label"],
                    status=stage["status"],
                    attempt=stage["attempt"],
                    started_at=_parse(stage["started_at"]),
                    finished_at=_parse(stage["finished_at"]),
                    return_code=stage["return_code"],
                    error_code=stage["error_code"],
                    error_message=stage["error_message"],
                    artifact_ids=json.loads(stage["artifact_ids_json"]),
                    idempotency_key=stage["idempotency_key"],
                )
                for stage in stages
            ],
        )
