"""Desktop-only first-sync progress and an explicit, durable balance confirmation."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from trading_max.desktop_workspace import WorkspaceError, read_manifest

from ..credentials import CredentialStoreError
from ..job_errors import JobConflict
from ..models import ApiModel, JobRecord, JobStatus, ReadinessResponse
from .dependencies import app_service, require_write_auth
from .system import readiness

router = APIRouter(tags=["local-workspace"])
RECEIPT = "workspace-confirmation.json"


class WorkspaceConfirmation(ApiModel):
    run_id: str = Field(min_length=1, max_length=100)


class LocalWorkspaceStatus(ApiModel):
    name: str
    path: str
    connected_accounts: list[str]
    readiness: ReadinessResponse
    latest_full_job: JobRecord | None
    active_job_id: str | None
    can_confirm: bool
    confirmed: bool


def _workspace(request: Request) -> tuple[Path, dict]:
    settings = app_service(request, "settings")
    identifier = os.environ.get("TRADING_MAX_DESKTOP_WORKSPACE_ID")
    if not identifier or settings.deployment_mode != "local_workstation":
        raise HTTPException(status_code=404, detail="local desktop workspace required")
    try:
        manifest = read_manifest(settings.data_root)
    except (OSError, WorkspaceError) as exc:
        raise HTTPException(status_code=409, detail="workspace identity unavailable") from exc
    if manifest["id"] != identifier:
        raise HTTPException(status_code=409, detail="workspace identity changed")
    return settings.data_root, manifest


def _connections(request: Request) -> tuple[list[str], dict[str, str]]:
    accounts, fingerprints = [], {}
    for item in app_service(request, "settings_repository").list_integrations():
        if (
            item.provider == "trading212"
            and item.configured
            and item.enabled
            and not item.needs_secret
        ):
            try:
                available = bool(app_service(request, "credential_store").get(item.integration_id))
            except CredentialStoreError:
                available = False
            if available:
                accounts.append(item.profile)
                fingerprints[item.profile] = f"{item.credential_fingerprint}:{item.revision}"
    return sorted(accounts), fingerprints


def _receipt(root: Path) -> dict:
    path = root / RECEIPT
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 8192:
        return {}
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


@router.get("/v1/local-workspace", response_model=LocalWorkspaceStatus)
def local_workspace(request: Request) -> LocalWorkspaceStatus:
    root, manifest = _workspace(request)
    accounts, fingerprints = _connections(request)
    jobs = app_service(request, "jobs")
    full, _ = jobs.latest_refreshes()
    state = readiness(request)
    connections = app_service(request, "settings_repository").list_integrations()
    updated_at = max(
        (
            item.updated_at
            for item in connections
            if item.provider == "trading212" and item.profile in accounts
        ),
        default=None,
    )
    # A published old snapshot, research-only success or failed/partial refresh
    # cannot be presented as successful account enrollment.
    can_confirm = bool(
        accounts
        and state.status == "ready"
        and not jobs.active_job_id
        and full
        and full.status == JobStatus.SUCCEEDED
        and not full.skip_sync
        and full.scope in {"all", "accounts"}
        and full.snapshot_run_id == state.latest_run_id
        and full.started_at
        and updated_at
        and full.started_at >= updated_at
    )
    receipt = _receipt(root)
    confirmed = bool(
        accounts
        and receipt.get("workspace_id") == manifest["id"]
        and receipt.get("accounts") == fingerprints
        and receipt.get("run_id")
    )
    return LocalWorkspaceStatus(
        name=manifest["name"],
        path=str(root),
        connected_accounts=accounts,
        readiness=state,
        latest_full_job=full,
        active_job_id=jobs.active_job_id,
        can_confirm=can_confirm,
        confirmed=confirmed,
    )


@router.post(
    "/v1/local-workspace/confirm",
    response_model=LocalWorkspaceStatus,
    dependencies=[Depends(require_write_auth)],
)
def confirm_workspace(body: WorkspaceConfirmation, request: Request) -> LocalWorkspaceStatus:
    root, manifest = _workspace(request)
    current = local_workspace(request)
    if not current.can_confirm or current.readiness.latest_run_id != body.run_id:
        raise HTTPException(
            status_code=409,
            detail="Complete a successful account refresh before confirming the current totals",
        )
    _, fingerprints = _connections(request)
    value = {
        "workspace_id": manifest["id"],
        "run_id": body.run_id,
        "accounts": fingerprints,
        "confirmed_at": datetime.now(UTC).isoformat(),
    }
    temporary = root / (RECEIPT + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        temporary.chmod(0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(root / RECEIPT)
    return local_workspace(request)


@router.post(
    "/v1/local-workspace/refresh",
    response_model=JobRecord,
    dependencies=[Depends(require_write_auth)],
    status_code=202,
)
def first_refresh(request: Request) -> JobRecord:
    _workspace(request)
    accounts, _ = _connections(request)
    if not accounts:
        raise HTTPException(status_code=409, detail="Connect and save a Trading 212 account first")
    jobs = app_service(request, "jobs")
    if jobs.active_job_id:
        return jobs.get(jobs.active_job_id)
    try:
        return jobs.submit("all", skip_sync=False, tickers=[], trigger="on_demand")
    except JobConflict as exc:
        if jobs.active_job_id:
            return jobs.get(jobs.active_job_id)
        raise HTTPException(status_code=409, detail="Another refresh is already queued") from exc
