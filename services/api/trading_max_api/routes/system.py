"""Expose health, readiness, dashboard lenses, snapshots, and artifacts."""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from ..dashboard_models import (
    AccountCode,
    BenchmarkPricePoint,
    DashboardLensName,
    DashboardLensSnapshot,
    DashboardResponse,
    NavPoint,
    OverviewReviewSummary,
)
from ..models import HealthResponse, ReadinessResponse, SnapshotManifest
from .dependencies import app_service, latest_or_503

router = APIRouter()

_EMPTY_STORE_BOOTSTRAP_ERROR = "FileNotFoundError: no typed snapshot has been published"
_PORTFOLIO_TIME_ZONE = ZoneInfo("Europe/London")


def _portfolio_day(value: str) -> date | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(_PORTFOLIO_TIME_ZONE).date()


def _latest_intraday_points(points: list[NavPoint]) -> list[NavPoint]:
    """Return only the newest London portfolio day used by the 1D charts."""

    dated = [(point, _portfolio_day(point.date)) for point in points]
    latest_day = max((day for _, day in dated if day is not None), default=None)
    return [point for point, day in dated if latest_day is not None and day == latest_day]


def _benchmark_series_for_nav(
    dashboard_data: DashboardResponse,
) -> dict[str, list[BenchmarkPricePoint]]:
    """Discard benchmark history that cannot align with the account NAV."""

    daily_dates = [point.date[:10] for point in dashboard_data.nav if not point.intraday]
    if not daily_dates:
        return {}
    first_date = min(daily_dates)
    last_date = max(daily_dates)
    return {
        ticker: [point for point in points if first_date <= point.date[:10] <= last_date]
        for ticker, points in dashboard_data.benchmark_series.items()
    }


def _effective_bootstrap_error(
    request: Request,
    latest: SnapshotManifest | None,
) -> str | None:
    """Discard only the stale error produced by an initially empty store.

    Production workers publish snapshots outside the API process.  The API may
    consequently start before the first snapshot exists, record the expected
    empty-store error, and later observe a valid publication without restarting.
    Genuine bootstrap failures remain visible and continue to block readiness.
    """

    error = request.app.state.bootstrap_error
    if latest is not None and error == _EMPTY_STORE_BOOTSTRAP_ERROR:
        request.app.state.bootstrap_error = None
        return None
    return error


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    store = app_service(request, "store")
    jobs = app_service(request, "jobs")
    settings = app_service(request, "settings")
    latest = store.latest_manifest()
    bootstrap_error = _effective_bootstrap_error(request, latest)
    queue_health = jobs.queue_health() if hasattr(jobs, "queue_health") else {}
    worker_health = jobs.worker_health() if hasattr(jobs, "worker_health") else None
    artifact_age = (
        max(0.0, (datetime.now(UTC) - latest.created_at).total_seconds())
        if latest is not None
        else None
    )
    return HealthResponse(
        status="ok" if latest is not None else "degraded",
        latest_run_id=latest.run_id if latest else None,
        bootstrap_error=bootstrap_error,
        active_job_id=jobs.active_job_id,
        write_auth_enabled=settings.api_token is not None,
        queue=queue_health,
        worker=worker_health,
        artifact_age_seconds=artifact_age,
    )


@router.get("/ready", response_model=ReadinessResponse)
def readiness(request: Request) -> ReadinessResponse:
    store = app_service(request, "store")
    jobs = app_service(request, "jobs")
    latest = store.latest_manifest()
    queue_health = jobs.queue_health() if hasattr(jobs, "queue_health") else {}
    worker_health = jobs.worker_health() if hasattr(jobs, "worker_health") else None
    worker_ready = bool(worker_health and worker_health.get("healthy"))
    bootstrap_error = _effective_bootstrap_error(request, latest)
    ready = latest is not None and bootstrap_error is None and worker_ready
    return ReadinessResponse(
        status="ready" if ready else "not_ready",
        latest_run_id=latest.run_id if latest else None,
        bootstrap_error=bootstrap_error,
        worker=worker_health,
        queue=queue_health,
    )


@router.get("/v1/dashboard", response_model=DashboardResponse)
def dashboard(request: Request) -> DashboardResponse:
    return request.app.state.cached_dashboard(latest_or_503(request))


@router.get(
    "/v1/dashboard/lens/{view}",
    response_model=DashboardLensSnapshot,
    response_model_exclude_defaults=True,
    response_model_exclude_none=True,
)
def dashboard_lens(
    view: DashboardLensName,
    request: Request,
    account: AccountCode | None = None,
) -> DashboardLensSnapshot:
    manifest = latest_or_503(request)
    dashboard_data = request.app.state.cached_dashboard(manifest)
    base = {
        "view": view,
        "run_id": manifest.run_id,
        "generated_at": dashboard_data.generated_at,
        "broker_as_of": dashboard_data.broker_as_of,
        "research_as_of": dashboard_data.research_as_of,
    }

    if view == "overview":
        held = {holding.ticker for holding in dashboard_data.holdings}
        account_names = {item.code: item.name for item in dashboard_data.accounts}
        review_summaries = [
            OverviewReviewSummary(
                account=code,
                name=account_names.get(code, code),
                coverage_start=review.coverage.start_date,
                coverage_end=review.coverage.end_date,
                max_pnl_drawdown_gbp=review.money_outcome.max_pnl_drawdown_gbp,
                net_pnl_gbp=review.money_outcome.net_pnl_gbp,
                net_pnl_rate=review.money_outcome.net_pnl_rate,
                event_count=review.coverage.transaction_count,
                phase_count=len(review.phases.items),
            )
            for code, review in dashboard_data.account_reviews.items()
        ]
        if dashboard_data.cfd_review is not None:
            cfd_review = dashboard_data.cfd_review
            review_summaries.append(
                OverviewReviewSummary(
                    account="C",
                    name=dashboard_data.cfd.name if dashboard_data.cfd else "CFD",
                    coverage_start=cfd_review.coverage_start,
                    coverage_end=cfd_review.coverage_end,
                    max_pnl_drawdown_gbp=cfd_review.money_outcome.max_realised_pnl_drawdown_gbp,
                    net_pnl_gbp=cfd_review.money_outcome.net_realised_pnl_gbp,
                    event_count=cfd_review.event_count,
                    phase_count=len(cfd_review.phases.items),
                )
            )
        return DashboardLensSnapshot(
            **base,
            total_value_gbp=dashboard_data.total_value_gbp,
            total_cash_gbp=dashboard_data.total_cash_gbp,
            total_invested_gbp=dashboard_data.total_invested_gbp,
            total_unrealized_pnl_gbp=dashboard_data.total_unrealized_pnl_gbp,
            latest_model_day_return=dashboard_data.latest_model_day_return,
            household_total_value_gbp=dashboard_data.household_total_value_gbp,
            accounts=[item for item in dashboard_data.accounts if item.is_investable],
            cfd=dashboard_data.cfd,
            review_summaries=review_summaries,
            holdings=dashboard_data.holdings,
            technical=[item for item in dashboard_data.technical if item.ticker in held],
            valuations=[item for item in dashboard_data.valuations if item.ticker in held],
            nav=dashboard_data.nav[-31:],
            intraday_nav=_latest_intraday_points(dashboard_data.intraday_nav),
        )
    if view == "holdings-positions":
        return DashboardLensSnapshot(
            **base,
            accounts=[item for item in dashboard_data.accounts if item.is_investable],
            total_value_gbp=dashboard_data.total_value_gbp,
            total_cash_gbp=dashboard_data.total_cash_gbp,
            total_invested_gbp=dashboard_data.total_invested_gbp,
            total_unrealized_pnl_gbp=dashboard_data.total_unrealized_pnl_gbp,
            holdings=dashboard_data.holdings,
        )
    if view == "holdings-lookthrough":
        return DashboardLensSnapshot(
            **base,
            lookthrough=dashboard_data.lookthrough,
        )
    if view == "analytics":
        return DashboardLensSnapshot(
            **base,
            accounts=dashboard_data.accounts,
            cfd=dashboard_data.cfd,
            nav=dashboard_data.nav,
            intraday_nav=dashboard_data.intraday_nav,
            risk=dashboard_data.risk,
            benchmark_series=_benchmark_series_for_nav(dashboard_data),
            policy=dashboard_data.policy,
        )
    if view == "review":
        return DashboardLensSnapshot(
            **base,
            accounts=dashboard_data.accounts,
            cfd=dashboard_data.cfd,
            risk=dashboard_data.risk,
        )

    selected = account or "A"
    selected_account = next(
        (item for item in dashboard_data.accounts if item.code == selected),
        None,
    )
    if selected_account is None and selected != "C":
        raise HTTPException(status_code=404, detail=f"account {selected} is unavailable")
    return DashboardLensSnapshot(
        **base,
        cfd=dashboard_data.cfd if selected == "C" else None,
        selected_account=selected_account,
        selected_account_analysis=dashboard_data.account_analysis.get(selected),
        selected_account_review=(
            dashboard_data.account_reviews.get(selected) if selected in {"A", "B"} else None
        ),
        selected_cfd_review=(dashboard_data.cfd_review if selected == "C" else None),
        selected_account_report=dashboard_data.account_report.analysis.get(selected, {}),
        selected_risk=(dashboard_data.risk.get(selected) if selected in {"A", "B"} else None),
        holdings=[holding for holding in dashboard_data.holdings if holding.account == selected],
        nav=dashboard_data.nav,
        intraday_nav=dashboard_data.intraday_nav,
    )


@router.get("/v1/snapshots/latest", response_model=SnapshotManifest)
def latest_snapshot(request: Request) -> SnapshotManifest:
    return latest_or_503(request)


@router.get("/v1/snapshots/{run_id}", response_model=SnapshotManifest)
def snapshot(run_id: str, request: Request) -> SnapshotManifest:
    try:
        return app_service(request, "store").load_manifest(run_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/v1/artifacts/{artifact_key:path}")
def latest_artifact(artifact_key: str, request: Request) -> FileResponse:
    try:
        path, artifact = app_service(request, "store").latest_artifact_path(
            artifact_key,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(
        path,
        media_type=artifact.media_type,
        filename=path.name,
    )


@router.get("/v1/snapshots/{run_id}/artifacts/{artifact_key:path}")
def snapshot_artifact(
    run_id: str,
    artifact_key: str,
    request: Request,
) -> FileResponse:
    try:
        path, artifact = app_service(request, "store").artifact_path(
            run_id,
            artifact_key,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(
        path,
        media_type=artifact.media_type,
        filename=path.name,
    )
