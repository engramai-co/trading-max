"""Durable backup queue, independent of interactive/deployment lifetimes."""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backup_repository import atomic_json, exclusive_lock
from .physical_recovery import archive_checkpoint
from .recovery_checkpoint import checkpoint
from .recovery_verification import VerificationSession


def deployment_requested(service: Path) -> bool:
    for path in service.glob(".deployment-request-*.json"):
        if path.is_symlink() or time.time() - path.stat().st_mtime > 300:
            continue
        try:
            pid = json.loads(path.read_bytes())["pid"]
            if type(pid) is not int or pid <= 0:
                continue
            os.kill(pid, 0)
            return True
        except (OSError, ValueError, KeyError):
            continue
    return False


def deployment_active(service: Path) -> bool:
    try:
        with exclusive_lock(service / ".deployment.lock"):
            return False
    except RuntimeError:
        return True


def pending(repository) -> list[str]:
    result = []
    for path in sorted((repository.root / "checkpoints").glob("*/checkpoint.json")):
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError("backup queue must not contain symlinks")
        repository.manifest_path(path.parent.name)
        value = json.loads(path.read_bytes())
        if not value.get("archived") or (path.parent / "state").exists():
            result.append(path.parent.name)
    return result


def maintenance_pending(result) -> bool:
    if not isinstance(result, dict):
        return False
    return any(result.get(key, 0) > 0 for key in ("remainingFiles", "remainingItems")) or any(
        maintenance_pending(value) for value in result.values() if isinstance(value, dict)
    )


def run_background(
    repository,
    state: Path,
    *,
    service: Path | None = None,
    force=False,
    maintain=None,
    wait_for_deployment=0,
) -> dict:
    status_path = repository.root / "background-status.json"
    if status_path.is_symlink():
        raise ValueError("backup status must not be a symlink")
    previous = json.loads(status_path.read_bytes()) if status_path.exists() else {}
    status = {**previous, "updatedAt": datetime.now(UTC).isoformat()}
    started = time.monotonic()
    parent_progress = repository.progress
    parent_session = repository.verification_session
    last_progress = 0.0
    last_phase = None
    in_maintenance = False

    def save(state_name, **values):
        status.update(status=state_name, updatedAt=datetime.now(UTC).isoformat(), **values)
        atomic_json(status_path, status)

    def progress(details):
        nonlocal last_progress, last_phase
        # A deployment only waits for a bounded file operation, never the full
        # archival job. Completed objects/journal survive this cooperative yield.
        if service and (
            deployment_requested(service) or (not in_maintenance and deployment_active(service))
        ):
            raise InterruptedError("backup yielded to deployment; checkpoint retained")
        if parent_progress:
            parent_progress(details)
        if details["phase"] != last_phase or time.monotonic() - last_progress > 5:
            save(
                "running",
                progress=details,
                seconds=round(time.monotonic() - started, 3),
            )
            last_progress = time.monotonic()
            last_phase = details["phase"]

    with exclusive_lock(repository.root / ".background.lock"):
        wait_until = time.monotonic() + wait_for_deployment
        while service and deployment_active(service) and time.monotonic() < wait_until:
            time.sleep(0.25)
        if service and deployment_active(service):
            save("deferred", reason="deployment-active")
            return status
        queued = pending(repository)
        last = status.get("lastBackup", {}).get("createdAt") or status.get("lastSuccessAt")
        due = not last or datetime.now(UTC) - datetime.fromisoformat(last) >= timedelta(hours=24)
        maintenance_only = (
            not queued
            and not force
            and not due
            and (status.get("maintenanceError") or status.get("maintenancePending"))
            and maintain
        )
        if not queued and not force and not due and not maintenance_only:
            return {**status, "status": "idle", "reason": "recovery-point-current"}
        repository.progress = progress
        repository.verification_session = VerificationSession()
        save(
            "running",
            startedAt=datetime.now(UTC).isoformat(),
            error=None,
            reason=None,
            seconds=0,
            phase="starting",
            progress=None,
            maintenance=None,
            maintenanceError=None,
            pending=len(queued),
        )
        results = []
        try:
            if not queued and not maintenance_only:
                queued.append(checkpoint(repository, state, label="nightly")["id"])
            if maintenance_only:
                results.append(status["lastBackup"])
            for backup_id in queued:
                save("running", checkpointId=backup_id, phase="archiving")
                result = archive_checkpoint(repository, backup_id)
                results.append(result)
                save(
                    "running",
                    lastSuccessAt=datetime.now(UTC).isoformat(),
                    lastBackupId=backup_id,
                    lastBackup=result,
                    error=None,
                )
            # A successful recovery point remains successful if optional bounded
            # storage maintenance fails. Its error is recorded separately.
            if maintain:
                in_maintenance = True
                save("running", phase="maintenance", maintenancePending=True)
                try:
                    status["maintenance"] = maintain(results[-1])
                    status["maintenanceError"] = None
                    status["maintenancePending"] = maintenance_pending(status["maintenance"])
                except (InterruptedError, TimeoutError):
                    raise
                except (OSError, ValueError, RuntimeError) as exc:
                    status["maintenanceError"] = type(exc).__name__ + ": " + str(exc)
            save(
                "succeeded",
                phase="maintenance-pending" if status.get("maintenancePending") else "complete",
                seconds=round(time.monotonic() - started, 3),
                pending=len(pending(repository)),
            )
            return status
        except (InterruptedError, TimeoutError) as exc:
            save(
                "deferred",
                phase="resume-pending",
                error=str(exc),
                seconds=round(time.monotonic() - started, 3),
            )
            return status
        except BaseException as exc:
            save(
                "failed",
                error=type(exc).__name__ + ": " + str(exc),
                seconds=round(time.monotonic() - started, 3),
            )
            raise
        finally:
            repository.progress = parent_progress
            repository.verification_session = parent_session
