"""Expose typed LLM analysis run and artifact endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..analysis_lenses import lens_for_page
from ..models import (
    AnalysisArtifact,
    AnalysisLens,
    AnalysisPage,
    AnalysisRunList,
    AnalysisRunRecord,
    AnalysisRunRequest,
    AnalysisStatusResponse,
)
from ..provider_runtime import ProviderRuntimeError
from .dependencies import app_service, require_write_auth

router = APIRouter(prefix="/v1/analysis", tags=["analysis"])


@router.get("/status", response_model=AnalysisStatusResponse)
def analysis_status(request: Request) -> AnalysisStatusResponse:
    analysis = app_service(request, "analysis")
    latest = analysis.list(limit=1)
    return AnalysisStatusResponse(
        provider=analysis.provider.name,
        model=analysis.provider.model,
        fake=analysis.provider.fake,
        latest_run=latest[0] if latest else None,
    )


@router.get("/runs", response_model=AnalysisRunList)
def analysis_runs(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AnalysisRunList:
    return AnalysisRunList(
        runs=app_service(request, "analysis").list(limit=limit),
    )


@router.get("/runs/{run_id}", response_model=AnalysisRunRecord)
def analysis_run(run_id: str, request: Request) -> AnalysisRunRecord:
    try:
        return app_service(request, "analysis").get(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/artifacts/{artifact_id}", response_model=AnalysisArtifact)
def analysis_artifact(artifact_id: str, request: Request) -> AnalysisArtifact:
    try:
        return app_service(request, "analysis").get_artifact(artifact_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/latest", response_model=AnalysisArtifact)
def latest_analysis(
    request: Request,
    lens: AnalysisLens | None = None,
    page: AnalysisPage | None = None,
    ticker: str | None = None,
    snapshot_run_id: str | None = None,
) -> AnalysisArtifact:
    selected_lens = lens or (lens_for_page(page) if page is not None else None)
    if selected_lens is None:
        raise HTTPException(status_code=422, detail="lens is required")
    try:
        return app_service(request, "analysis").latest(
            lens=selected_lens,
            ticker=ticker,
            snapshot_run_id=snapshot_run_id,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post(
    "/runs",
    response_model=AnalysisRunRecord,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def create_analysis_run(
    request_body: AnalysisRunRequest,
    request: Request,
) -> AnalysisRunRecord:
    selected_lenses = request_body.lenses or [lens_for_page(page) for page in request_body.pages]
    try:
        return app_service(request, "analysis").submit(
            lenses=selected_lenses or None,
            ticker=request_body.ticker,
            trigger="on_demand",
            force=request_body.force,
        )
    except ProviderRuntimeError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": exc.code,
                "message": ("analysis route is not available; configure the selected provider"),
            },
        ) from exc
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
