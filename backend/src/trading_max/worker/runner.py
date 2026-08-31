"""Worker loop that executes typed stages with durable queue transitions."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Sequence
from contextlib import suppress

from trading_max.application import StageContext, StageRegistry
from trading_max.application.errors import StageExecutionError
from trading_max.domain.contracts import JobStatus, StageStatus
from trading_max.infrastructure.job_queue import ClaimedJob, SqliteJobQueue


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
        self.allowed_triggers = tuple(allowed_triggers) if allowed_triggers is not None else None
        self.worker_version = "durable-worker-v1"
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
        snapshot_run_id: str | None = None
        upstream_artifact_ids = tuple(
            artifact_id
            for record in claimed.record.stages
            if record.status == StageStatus.SUCCEEDED
            for artifact_id in record.artifact_ids
        )
        try:
            try:
                self.registry.validate_order(
                    [stage_record.name for stage_record in claimed.record.stages]
                )
            except (KeyError, ValueError) as exc:
                self.queue.fail(
                    claimed.record.job_id,
                    self.worker_id,
                    error_code="stage.dependency_invalid",
                    error_message=str(exc),
                )
                return True
            for stage_record in claimed.record.stages:
                if self.queue.cancellation_requested(
                    claimed.record.job_id,
                    self.worker_id,
                ):
                    self.queue.cancel_running(
                        claimed.record.job_id,
                        self.worker_id,
                    )
                    return True
                if stage_record.status == StageStatus.SUCCEEDED:
                    continue
                stage = self.registry.get(stage_record.name)
                if stage.version != stage_record.version:
                    message = f"queued {stage_record.version}, registered {stage.version}"
                    self.queue.set_stage(
                        claimed.record.job_id,
                        self.worker_id,
                        stage_record.name,
                        StageStatus.FAILED,
                        error_code="stage.version_mismatch",
                        error_message=message,
                    )
                    self.queue.fail(
                        claimed.record.job_id,
                        self.worker_id,
                        error_code="stage.version_mismatch",
                        error_message=message,
                    )
                    return True
                self.queue.set_stage(
                    claimed.record.job_id,
                    self.worker_id,
                    stage_record.name,
                    StageStatus.RUNNING,
                )
                try:
                    result = stage.run(
                        StageContext(
                            job_id=claimed.record.job_id,
                            scope=(
                                "intraday"
                                if claimed.record.scope == "live"
                                else claimed.record.scope
                            ),
                            trigger=(
                                "intraday"
                                if claimed.record.trigger == "live"
                                else claimed.record.trigger
                            ),
                            skip_sync=claimed.record.skip_sync,
                            tickers=tuple(claimed.record.tickers),
                            scheduled_for=claimed.record.scheduled_for,
                            started_at=claimed.record.started_at,
                            log_path=claimed.record.log_path,
                            upstream_artifact_ids=upstream_artifact_ids,
                        )
                    )
                except StageExecutionError as exc:
                    self.queue.set_stage(
                        claimed.record.job_id,
                        self.worker_id,
                        stage_record.name,
                        StageStatus.FAILED,
                        error_code=exc.code,
                        error_message=str(exc),
                        return_code=exc.return_code,
                    )
                    self.queue.fail(
                        claimed.record.job_id,
                        self.worker_id,
                        error_code=exc.code,
                        error_message=str(exc),
                        return_code=exc.return_code,
                        retryable=exc.retryable,
                    )
                    return True
                except Exception as exc:
                    self.queue.set_stage(
                        claimed.record.job_id,
                        self.worker_id,
                        stage_record.name,
                        StageStatus.FAILED,
                        error_code="stage.unhandled",
                        error_message=str(exc),
                    )
                    self.queue.fail(
                        claimed.record.job_id,
                        self.worker_id,
                        error_code="stage.unhandled",
                        error_message=str(exc),
                    )
                    return True
                self.queue.set_stage(
                    claimed.record.job_id,
                    self.worker_id,
                    stage_record.name,
                    StageStatus.SUCCEEDED,
                    artifact_ids=[artifact.artifact_id for artifact in result.artifacts],
                )
                candidate_snapshot_id = result.metadata.get("snapshot_run_id")
                if isinstance(candidate_snapshot_id, str):
                    snapshot_run_id = candidate_snapshot_id
                upstream_artifact_ids = (
                    *upstream_artifact_ids,
                    *(artifact.artifact_id for artifact in result.artifacts),
                )
                self.queue.heartbeat(
                    claimed.record.job_id,
                    self.worker_id,
                    lease_seconds=self.lease_seconds,
                )
            if self.queue.cancellation_requested(
                claimed.record.job_id,
                self.worker_id,
            ):
                self.queue.cancel_running(
                    claimed.record.job_id,
                    self.worker_id,
                )
                return True
            self.queue.complete(
                claimed.record.job_id,
                self.worker_id,
                snapshot_run_id=snapshot_run_id or self.snapshot_id_factory(claimed),
            )
        except Exception:
            current = self.queue.get(claimed.record.job_id)
            if current.status == JobStatus.RUNNING:
                self.queue.fail(
                    claimed.record.job_id,
                    self.worker_id,
                    error_code="worker.unhandled",
                    error_message="worker failed outside a stage boundary",
                )
            raise
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1)
            with suppress(Exception):
                self.heartbeat()
            if self.on_job_finished is not None:
                with suppress(Exception):
                    self.on_job_finished(
                        self.queue.get(claimed.record.job_id).status,
                        claimed,
                    )
        return True
