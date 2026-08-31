"""Expose refresh jobs, schedules, logs, and lightweight alert operations."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse

from ..job_errors import JobConflict
from ..models import (
    AlertMonitorState,
    JobList,
    JobRecord,
    RefreshRequest,
    RefreshState,
)
from .dependencies import app_service, require_write_auth

router = APIRouter(tags=["operations"])


@router.get("/v1/alerts/status", response_model=AlertMonitorState)
def alert_monitor_status(request: Request) -> AlertMonitorState:
    return AlertMonitorState.model_validate(
        app_service(request, "alert_monitor").status(),
    )


@router.post(
    "/v1/alerts/refresh",
    response_model=AlertMonitorState,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def refresh_alerts(request: Request) -> AlertMonitorState:
    return AlertMonitorState.model_validate(
        app_service(request, "alert_monitor").run_once(force=True),
    )


@router.get("/v1/jobs", response_model=JobList)
def list_jobs(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> JobList:
    return JobList(jobs=app_service(request, "jobs").list(limit=limit))


@router.get("/v1/jobs/{job_id}", response_model=JobRecord)
def get_job(job_id: str, request: Request) -> JobRecord:
    try:
        return app_service(request, "jobs").get(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post(
    "/v1/jobs/{job_id}/cancel",
    response_model=JobRecord,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def cancel_job(job_id: str, request: Request) -> JobRecord:
    jobs = app_service(request, "jobs")
    cancel = getattr(jobs, "cancel", None)
    if cancel is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="durable job cancellation is not enabled",
        )
    try:
        return cancel(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/v1/jobs/{job_id}/log", response_class=PlainTextResponse)
def job_log(job_id: str, request: Request) -> str:
    try:
        return app_service(request, "jobs").log(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/v1/refresh-state", response_model=RefreshState)
def refresh_state(request: Request) -> RefreshState:
    jobs = app_service(request, "jobs")
    latest_full, latest_intraday = jobs.latest_refreshes()
    recent = jobs.list(limit=1)
    return RefreshState(
        active_job_id=jobs.active_job_id,
        latest_job=recent[0] if recent else None,
        latest_full_job=latest_full,
        latest_intraday_job=latest_intraday,
        nightly=app_service(request, "scheduler").status(),
        intraday=app_service(request, "intraday_scheduler").status(),
        live=app_service(request, "intraday_scheduler").status(),
        performance=app_service(request, "performance_scheduler").status(),
        research=app_service(request, "scheduler").status(),
        alerts=AlertMonitorState.model_validate(
            app_service(request, "alert_monitor").status(),
        ),
    )


@router.post(
    "/v1/jobs/refresh",
    response_model=JobRecord,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def refresh(request_body: RefreshRequest, request: Request) -> JobRecord:
    try:
        return app_service(request, "jobs").submit(
            request_body.scope,
            skip_sync=request_body.skip_sync,
            tickers=request_body.tickers,
            trigger="on_demand",
        )
    except JobConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
