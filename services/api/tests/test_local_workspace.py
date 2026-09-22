"""First-sync acceptance requires both backend readiness and explicit user confirmation."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from trading_max.desktop_workspace import create_workspace

from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.models import IntegrationSummary, JobRecord, JobStatus
from services.api.trading_max_api.routes.local_workspace import router


@pytest.fixture
def local_client(tmp_path, monkeypatch):
    workspace = create_workspace(tmp_path, "test-workspace")
    root = Path(workspace["path"])
    monkeypatch.setenv("TRADING_MAX_DESKTOP_WORKSPACE_ID", workspace["id"])
    now = datetime.now(UTC)
    integration = IntegrationSummary(
        integration_id="trading212:invest",
        provider="trading212",
        profile="invest",
        configured=True,
        enabled=True,
        needs_secret=False,
        credential_fingerprint="test-hash",
        updated_at=now - timedelta(minutes=2),
    )
    job = JobRecord(
        job_id="test-job",
        scope="all",
        skip_sync=False,
        status=JobStatus.SUCCEEDED,
        created_at=now,
        started_at=now,
        snapshot_run_id="test-run",
    )
    app = FastAPI()
    app.include_router(router)
    app.state.settings = SimpleNamespace(
        data_root=root, deployment_mode="local_workstation", api_token="synthetic-token"
    )
    app.state.settings_repository = Mock()
    app.state.settings_repository.list_integrations.return_value = [integration]
    app.state.credential_store = InMemoryCredentialStore(
        {"trading212:invest": "synthetic-test-secret"}
    )
    app.state.store = Mock()
    app.state.store.latest_manifest.return_value = SimpleNamespace(run_id="test-run")
    app.state.bootstrap_error = None
    jobs = app.state.jobs = Mock()
    jobs.latest_refreshes.return_value = (job, None)
    jobs.active_job_id = None
    jobs.worker_health.return_value = {"healthy": True}
    jobs.queue_health.return_value = {}
    jobs.submit.return_value = job
    jobs.get.return_value = job
    with TestClient(app) as client:
        yield client, app, job


def test_valid_sync_requires_explicit_confirmation_and_keeps_no_secrets(local_client):
    client, app, _job = local_client
    state = client.get("/v1/local-workspace").json()
    assert state["canConfirm"] and not state["confirmed"]
    assert client.post("/v1/local-workspace/confirm", json={"runId": "test-run"}).status_code == 401
    result = client.post(
        "/v1/local-workspace/confirm",
        json={"runId": "test-run"},
        headers={"Authorization": "Bearer synthetic-token"},
    )
    assert result.status_code == 200 and result.json()["confirmed"]
    receipt = app.state.settings.data_root / "workspace-confirmation.json"
    assert "synthetic-test-secret" not in receipt.read_text()
    assert receipt.stat().st_mode & 0o777 == 0o600
    # A copied folder on a device without its Keychain entry must reconnect.
    app.state.credential_store.values.clear()
    state = client.get("/v1/local-workspace").json()
    assert not state["confirmed"] and not state["connectedAccounts"]


@pytest.mark.parametrize(
    "failure", ["worker", "failed", "running", "research", "skip", "stale-run", "rotated-key"]
)
def test_incomplete_or_old_data_never_passes_acceptance(local_client, failure):
    client, app, job = local_client
    if failure == "worker":
        app.state.jobs.worker_health.return_value = {"healthy": False}
    if failure == "failed":
        job.status = JobStatus.FAILED
    if failure == "running":
        app.state.jobs.active_job_id = "test-job"
    if failure == "research":
        job.scope = "research"
    if failure == "skip":
        job.skip_sync = True
    if failure == "stale-run":
        job.snapshot_run_id = "old-run"
    if failure == "rotated-key":
        app.state.settings_repository.list_integrations.return_value[0].updated_at = datetime.now(
            UTC
        ) + timedelta(minutes=1)
    assert not client.get("/v1/local-workspace").json()["canConfirm"]
    response = client.post(
        "/v1/local-workspace/confirm",
        json={"runId": "test-run"},
        headers={"Authorization": "Bearer synthetic-token"},
    )
    assert response.status_code == 409
    assert not (app.state.settings.data_root / "workspace-confirmation.json").exists()


def test_refresh_resumes_active_job_without_submitting_again(local_client):
    client, app, _ = local_client
    app.state.jobs.active_job_id = "existing"
    response = client.post(
        "/v1/local-workspace/refresh", json={}, headers={"Authorization": "Bearer synthetic-token"}
    )
    assert response.status_code == 202
    app.state.jobs.submit.assert_not_called()
    app.state.jobs.active_job_id = None
    response = client.post(
        "/v1/local-workspace/refresh", json={}, headers={"Authorization": "Bearer synthetic-token"}
    )
    assert response.status_code == 202
    app.state.jobs.submit.assert_called_once_with(
        "all", skip_sync=False, tickers=[], trigger="on_demand"
    )


def test_workspace_api_absent_on_ordinary_servers(local_client, monkeypatch):
    client, _, _ = local_client
    monkeypatch.delenv("TRADING_MAX_DESKTOP_WORKSPACE_ID")
    assert client.get("/v1/local-workspace").status_code == 404
