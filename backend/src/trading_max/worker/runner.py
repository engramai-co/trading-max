"""Worker loop that executes typed stages with durable queue transitions."""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from contextlib import suppress

from trading_max.application import StageContext, StageRegistry, StageResult
from trading_max.application.errors import PublicationCancelled, StageExecutionError, WorkerShutdown
from trading_max.domain.contracts import JobRecord, JobStatus, StageStatus
from trading_max.infrastructure.job_queue import (
    LIVE_LANE_WORKER_VERSION,
    AccountEvidence,
    ClaimedJob,
    QueueConflict,
    SqliteJobQueue,
)

LOGGER = logging.getLogger(__name__)

MAIN_LANE_TRIGGERS: tuple[str, ...] = (
    "on_demand",
    "nightly",
    "performance",
    "research",
    "reconciliation",
)
LIVE_LANE_TRIGGERS: tuple[str, ...] = (
    "intraday",
    "live",
)
ANALYSIS_LANE_TRIGGERS: tuple[str, ...] = ("system",)


def _database_busy(exc: sqlite3.OperationalError) -> bool:
    code = getattr(exc, "sqlite_errorcode", None)
    if code is not None:
        return code & 0xFF in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
    return str(exc) in {"database is locked", "database table is locked"}


class DurableWorker:
    """Claim and execute one job at a time; safe to restart between jobs."""

    def __init__(
        self,
        queue: SqliteJobQueue,
        registry: StageRegistry,
        *,
        worker_id: str | None = None,
        lease_seconds: int = 300,
        snapshot_id_factory: Callable[[ClaimedJob], str] | None = None,
        on_job_started: Callable[[ClaimedJob], None] | None = None,
        on_job_finished: Callable[[JobStatus, ClaimedJob], None] | None = None,
        allowed_triggers: Sequence[str] | None = None,
        stop_event: threading.Event | None = None,
        account_evidence: Callable[[JobRecord, tuple[str, ...]], dict[str, AccountEvidence]]
        | None = None,
    ) -> None:
        self.queue = queue
        self.registry = registry
        self.worker_id = worker_id or f"worker-{uuid.uuid4().hex[:12]}"
        self.lease_seconds = lease_seconds
        self.snapshot_id_factory = snapshot_id_factory or (
            lambda claimed: f"pending-{claimed.record.job_id}"
        )
        self.on_job_started = on_job_started
        self.on_job_finished = on_job_finished
        self.account_evidence = account_evidence
        self.stop_event = stop_event
        self.allowed_triggers = tuple(allowed_triggers) if allowed_triggers is not None else None
        self.worker_version = (
            LIVE_LANE_WORKER_VERSION
            if self.allowed_triggers == MAIN_LANE_TRIGGERS
            else "durable-worker-v1"
        )
        self.queue.register_worker(
            self.worker_id,
            worker_version=self.worker_version,
        )
        self.queue.heartbeat_worker(self.worker_id, status="idle")

    def heartbeat(self) -> None:
        """Publish an idle/running heartbeat for the API readiness probe."""

        self.queue.heartbeat_worker(self.worker_id, status="idle")

    def close(self) -> None:
        self.queue.unregister_worker(self.worker_id)

    def run_loop(
        self,
        stop: threading.Event,
        poll_seconds: float,
        *,
        before_poll: Callable[[], None] | None = None,
    ) -> None:
        """Run this lane until stopped, cooling down after SQLite contention."""
        backoff = 0.1
        try:
            while not stop.is_set():
                try:
                    if before_poll is not None:
                        before_poll()
                    worked = self.run_once()
                except sqlite3.OperationalError as exc:
                    if not _database_busy(exc):
                        raise
                    LOGGER.warning("worker queue busy", extra={"worker_id": self.worker_id})
                    stop.wait(backoff)
                    backoff = min(5.0, backoff * 2)
                    continue
                backoff = 0.1
                if not worked:
                    stop.wait(max(0.1, min(poll_seconds, 60.0)))
        except Exception:
            LOGGER.exception(
                "worker lane stopped unexpectedly", extra={"worker_id": self.worker_id}
            )
        finally:
            try:
                self.close()
            except sqlite3.Error:
                LOGGER.exception("worker lane could not record its shutdown")

    def _start_job_heartbeat(self, claimed: ClaimedJob) -> tuple[threading.Event, threading.Thread]:
        stop = threading.Event()
        interval = max(1.0, min(self.lease_seconds / 3, 30.0))

        def renew() -> None:
            while not stop.wait(interval):
                try:
                    self.queue.heartbeat(
                        claimed.record.job_id,
                        self.worker_id,
                        lease_seconds=self.lease_seconds,
                    )
                    self.queue.heartbeat_worker(
                        self.worker_id,
                        status="running",
                        current_job_id=claimed.record.job_id,
                    )
                except sqlite3.OperationalError as exc:
                    if not _database_busy(exc):
                        return
                except Exception:
                    # The owning worker will surface the authoritative queue
                    # error at the next stage boundary. The heartbeat thread
                    # must not crash the process or hide that error.
                    return

        thread = threading.Thread(
            target=renew,
            name=f"trading_max-heartbeat-{claimed.record.job_id[:8]}",
            daemon=True,
        )
        thread.start()
        return stop, thread

    def _complete_job(
        self,
        claimed: ClaimedJob,
        snapshot_run_id: str,
        upstream_artifact_ids: tuple[str, ...],
    ) -> None:
        evidence = (
            self.account_evidence(claimed.record, upstream_artifact_ids)
            if self.account_evidence is not None
            else None
        )
        for delay in (0.1, 0.2, 0.4, None):
            try:
                self.queue.complete(
                    claimed.record.job_id,
                    self.worker_id,
                    snapshot_run_id=snapshot_run_id,
                    account_evidence=evidence,
                )
                return
            except QueueConflict:
                # A claimant with a fresh lease may have taken over. It can
                # complete from the checkpoint without publishing again.
                return
            except sqlite3.OperationalError as exc:
                if not _database_busy(exc) or delay is None:
                    raise
                if self.stop_event is None:
                    time.sleep(delay)
                elif self.stop_event.wait(delay):
                    raise

    def run_once(self) -> bool:
        claimed = self.queue.claim(
            self.worker_id,
            lease_seconds=self.lease_seconds,
            allowed_triggers=self.allowed_triggers,
        )
        if claimed is None:
            with suppress(Exception):
                self.heartbeat()
            return False
        with suppress(Exception):
            self.queue.heartbeat_worker(
                self.worker_id,
                status="running",
                current_job_id=claimed.record.job_id,
            )
        heartbeat_stop, heartbeat_thread = self._start_job_heartbeat(claimed)
        if self.on_job_started is not None:
            with suppress(Exception):
                self.on_job_started(claimed)
        job_id = claimed.record.job_id
        trigger = "intraday" if claimed.record.trigger == "live" else claimed.record.trigger
        intent = claimed.record.snapshot_run_id
        snapshot_run_id = None
        publication_visible = None

        def prepare_publication(run_id: str) -> None:
            nonlocal intent
            if self.stop_event is not None and self.stop_event.is_set():
                raise WorkerShutdown("worker stopped before snapshot publication")
            if not self.queue.prepare_publication(job_id, self.worker_id, run_id):
                raise PublicationCancelled()
            intent = run_id

        upstream_artifact_ids = tuple(
            artifact_id
            for record in claimed.record.stages
            if record.status == StageStatus.SUCCEEDED
            for artifact_id in record.artifact_ids
        )
        recovering_publication = False
        try:
            for record in claimed.record.stages:
                if record.name == "snapshot.publish":
                    recovering_publication = intent is not None or claimed.record.attempts > 1
                    if not recovering_publication:
                        break
                    if intent is not None and record.status == StageStatus.SUCCEEDED:
                        snapshot_run_id = intent
                        break
                    stage = self.registry.get(record.name)
                    if intent is not None:
                        publication_visible = getattr(stage, "publication_visible", None)
                        if publication_visible is not None and publication_visible(intent):
                            snapshot_run_id = intent
                    else:
                        find_publication = getattr(stage, "find_publication", None)
                        if find_publication is not None:
                            snapshot_run_id = find_publication(job_id, trigger)
                    if snapshot_run_id is not None:
                        self.queue.set_stage(
                            job_id,
                            self.worker_id,
                            record.name,
                            StageStatus.SUCCEEDED,
                            snapshot_run_id=snapshot_run_id,
                        )
                    break
                if record.status != StageStatus.SUCCEEDED:
                    # Fresh upstream work must not trigger the recovery guard.
                    break
            if snapshot_run_id is None:
                try:
                    self.registry.validate_order(
                        [stage_record.name for stage_record in claimed.record.stages]
                    )
                except (KeyError, ValueError) as exc:
                    self.queue.fail(
                        job_id,
                        self.worker_id,
                        error_code="stage.dependency_invalid",
                        error_message=str(exc),
                    )
                    return True
            for stage_record in claimed.record.stages:
                if snapshot_run_id is not None:
                    break
                if self.stop_event is not None and self.stop_event.is_set():
                    raise WorkerShutdown("worker stopped at a stage boundary")
                if self.queue.cancellation_requested(job_id, self.worker_id):
                    raise PublicationCancelled()
                if stage_record.status == StageStatus.SUCCEEDED:
                    continue
                stage = self.registry.get(stage_record.name)
                if stage.version != stage_record.version:
                    message = f"queued {stage_record.version}, registered {stage.version}"
                    self.queue.set_stage(
                        job_id,
                        self.worker_id,
                        stage_record.name,
                        StageStatus.FAILED,
                        error_code="stage.version_mismatch",
                        error_message=message,
                    )
                    self.queue.fail(
                        job_id,
                        self.worker_id,
                        error_code="stage.version_mismatch",
                        error_message=message,
                    )
                    return True
                self.queue.set_stage(
                    job_id,
                    self.worker_id,
                    stage_record.name,
                    StageStatus.RUNNING,
                )
                publication_visible = getattr(stage, "publication_visible", None)
                try:
                    result = stage.run(
                        StageContext(
                            job_id=job_id,
                            scope=(
                                "intraday"
                                if claimed.record.scope == "live"
                                else claimed.record.scope
                            ),
                            trigger=trigger,
                            skip_sync=claimed.record.skip_sync,
                            tickers=tuple(claimed.record.tickers),
                            scheduled_for=claimed.record.scheduled_for,
                            started_at=claimed.record.started_at,
                            log_path=claimed.record.log_path,
                            upstream_artifact_ids=upstream_artifact_ids,
                            prepare_publication=prepare_publication
                            if publication_visible is not None
                            else None,
                            recovering_publication=recovering_publication,
                        )
                    )
                except (WorkerShutdown, PublicationCancelled, QueueConflict):
                    raise
                except Exception as exc:
                    if (
                        intent is not None
                        and publication_visible is not None
                        and publication_visible(intent)
                    ):
                        # The pointer swap succeeded, even though later work raised.
                        result = StageResult(metadata={"snapshot_run_id": intent})
                    else:
                        if isinstance(exc, sqlite3.OperationalError) and _database_busy(exc):
                            raise
                        code = (
                            exc.code if isinstance(exc, StageExecutionError) else "stage.unhandled"
                        )
                        retryable = isinstance(exc, StageExecutionError) and exc.retryable
                        return_code = (
                            exc.return_code if isinstance(exc, StageExecutionError) else None
                        )
                        self.queue.set_stage(
                            job_id,
                            self.worker_id,
                            stage_record.name,
                            StageStatus.FAILED,
                            error_code=code,
                            error_message=str(exc),
                            return_code=return_code,
                        )
                        self.queue.fail(
                            job_id,
                            self.worker_id,
                            error_code=code,
                            error_message=str(exc),
                            return_code=return_code,
                            retryable=retryable,
                        )
                        return True
                candidate_snapshot_id = result.metadata.get("snapshot_run_id")
                if isinstance(candidate_snapshot_id, str):
                    snapshot_run_id = candidate_snapshot_id
                self.queue.set_stage(
                    job_id,
                    self.worker_id,
                    stage_record.name,
                    StageStatus.SUCCEEDED,
                    artifact_ids=[artifact.artifact_id for artifact in result.artifacts],
                    snapshot_run_id=candidate_snapshot_id
                    if isinstance(candidate_snapshot_id, str)
                    else None,
                )
                upstream_artifact_ids = (
                    *upstream_artifact_ids,
                    *(artifact.artifact_id for artifact in result.artifacts),
                )
                self.queue.heartbeat(
                    job_id,
                    self.worker_id,
                    lease_seconds=self.lease_seconds,
                )
            if snapshot_run_id is None and self.queue.cancellation_requested(
                job_id, self.worker_id
            ):
                raise PublicationCancelled()
        except PublicationCancelled:
            self.queue.cancel_running(job_id, self.worker_id)
        except WorkerShutdown:
            self.queue.release(job_id, self.worker_id)
        except QueueConflict:
            # A different worker now owns the job.
            return True
        except Exception as exc:
            if snapshot_run_id is not None or (
                isinstance(exc, sqlite3.OperationalError) and _database_busy(exc)
            ):
                # Preserve the publication and its checkpoint for a later claim.
                raise
            current = self.queue.get(job_id)
            if current.status == JobStatus.RUNNING:
                self.queue.fail(
                    job_id,
                    self.worker_id,
                    error_code="worker.unhandled",
                    error_message="worker failed outside a stage boundary",
                )
            raise
        else:
            # Publication is already visible. Completion and its evidence are
            # one transaction, and a failed attempt must not fail the job.
            self._complete_job(
                claimed,
                snapshot_run_id or self.snapshot_id_factory(claimed),
                upstream_artifact_ids,
            )
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1)
            with suppress(Exception):
                self.heartbeat()
            if self.on_job_finished is not None:
                with suppress(Exception):
                    self.on_job_finished(
                        self.queue.get(job_id).status,
                        claimed,
                    )
        return True
