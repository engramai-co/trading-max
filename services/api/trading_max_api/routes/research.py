"""Expose research directory, shell, lens, and price-series endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..dashboard_models import (
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchPriceSeries,
    ResearchShell,
)
from ..job_errors import JobConflict
from ..models import (
    PortfolioImpact,
    ResearchAlert,
    ResearchEvent,
    ResearchInstrument,
    ResearchModelRun,
    ResearchOverview,
    ResearchStatus,
    ResearchTickerSnapshot,
    ResearchTimelinePoint,
    SecuritySearchResponse,
    SnapshotManifest,
    WatchlistAddRequest,
    WatchlistMoveRequest,
    WatchlistMutation,
    WatchlistState,
)
from ..watchlist import SecuritySearchError
from .dependencies import app_service, latest_or_503, require_write_auth

router = APIRouter(tags=["research"])


@router.get("/v1/research", response_model=ResearchOverview)
def research_overview(
    request: Request,
    ticker: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ResearchOverview:
    return request.app.state.cached_research(
        latest_or_503(request),
        ticker=ticker,
        limit=limit,
    )


@router.get("/v1/research/status", response_model=ResearchStatus)
def research_status(request: Request) -> ResearchStatus:
    return app_service(request, "research").status(latest_or_503(request))


@router.get("/v1/research/shell", response_model=ResearchShell)
def research_shell(request: Request) -> ResearchShell:
    return request.app.state.cached_research_shell(latest_or_503(request))


@router.get(
    "/v1/research/instruments",
    response_model=list[ResearchInstrument],
)
def research_instruments(request: Request) -> list[ResearchInstrument]:
    return app_service(request, "research").instruments(latest_or_503(request))


@router.get("/v1/watchlist", response_model=WatchlistState)
def get_watchlist(request: Request) -> WatchlistState:
    return app_service(request, "watchlist").load()


@router.get(
    "/v1/securities/search",
    response_model=SecuritySearchResponse,
)
def search_securities(
    request: Request,
    q: Annotated[str, Query(min_length=2, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
) -> SecuritySearchResponse:
    try:
        return app_service(request, "security_search").search(q, limit=limit)
    except SecuritySearchError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post(
    "/v1/watchlist",
    response_model=WatchlistMutation,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def add_watchlist_item(
    request_body: WatchlistAddRequest,
    request: Request,
) -> WatchlistMutation:
    watchlist = app_service(request, "watchlist")
    jobs = app_service(request, "jobs")
    try:
        item = watchlist.add(
            request_body.security,
            request_body.category_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    analysis = app_service(request, "analysis")
    analysis.taxonomy_workflow.record_pending(
        item,
        provider_available=analysis.provider_available("taxonomy"),
    )
    item = next(entry for entry in watchlist.items() if entry.ticker == item.ticker)
    job = None
    message = "Ticker added to the watchlist"
    if request_body.refresh:
        try:
            job = jobs.submit(
                "research",
                skip_sync=True,
                tickers=[item.ticker],
                trigger="on_demand",
            )
            message = "Ticker added; watchlist research refresh queued"
        except JobConflict:
            jobs.request_research_follow_up([item.ticker])
            message = "Ticker added; follow-up research refresh queued"
    return WatchlistMutation(item=item, job=job, message=message)


@router.post(
    "/v1/watchlist/{ticker}/move",
    response_model=WatchlistMutation,
    dependencies=[Depends(require_write_auth)],
)
def move_watchlist_item(
    ticker: str,
    request_body: WatchlistMoveRequest,
    request: Request,
) -> WatchlistMutation:
    try:
        item = app_service(request, "watchlist").move(
            ticker,
            request_body.category_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return WatchlistMutation(item=item, message="Ticker moved")


@router.post(
    "/v1/watchlist/{ticker}/remove",
    response_model=WatchlistMutation,
    dependencies=[Depends(require_write_auth)],
)
def remove_watchlist_item(ticker: str, request: Request) -> WatchlistMutation:
    try:
        item = app_service(request, "watchlist").remove(ticker)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return WatchlistMutation(item=item, message="Ticker removed")


@router.post(
    "/v1/watchlist/{ticker}/refresh",
    response_model=WatchlistMutation,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_write_auth)],
)
def refresh_watchlist_item(
    ticker: str,
    request: Request,
) -> WatchlistMutation:
    watchlist = app_service(request, "watchlist")
    selected = next(
        (item for item in watchlist.items() if item.ticker == ticker.upper()),
        None,
    )
    if selected is None:
        raise HTTPException(status_code=404, detail="watchlist ticker not found")
    try:
        job = app_service(request, "jobs").submit(
            "research",
            skip_sync=True,
            tickers=[selected.ticker],
            trigger="on_demand",
        )
    except JobConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    watchlist.set_status([selected.ticker], "pending")
    selected = next(item for item in watchlist.items() if item.ticker == selected.ticker)
    return WatchlistMutation(
        item=selected,
        job=job,
        message="Watchlist research refresh queued",
    )


@router.get(
    "/v1/research/snapshots",
    response_model=list[SnapshotManifest],
)
def research_snapshots(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[SnapshotManifest]:
    return app_service(request, "store").list_manifests(limit=limit)


@router.get(
    "/v1/research/{ticker}/timeline",
    response_model=list[ResearchTimelinePoint],
)
def research_timeline(
    ticker: str,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[ResearchTimelinePoint]:
    return app_service(request, "research").timeline(ticker, limit=limit)


@router.get(
    "/v1/research/{ticker}/prices",
    response_model=ResearchPriceSeries,
)
def research_prices(
    ticker: str,
    request: Request,
    limit: Annotated[int, Query(ge=2, le=2_000)] = 504,
) -> ResearchPriceSeries:
    try:
        return app_service(request, "research").price_series(
            ticker,
            latest_or_503(request),
            limit=limit,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get(
    "/v1/research/{ticker}/events",
    response_model=list[ResearchEvent],
)
def research_events(ticker: str, request: Request) -> list[ResearchEvent]:
    return app_service(request, "research").events(
        ticker,
        latest_or_503(request),
    )


@router.get(
    "/v1/research/{ticker}/models",
    response_model=list[ResearchModelRun],
)
def research_models(
    ticker: str,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[ResearchModelRun]:
    return app_service(request, "research").models(ticker, limit=limit)


@router.get(
    "/v1/research/{ticker}/portfolio-impact",
    response_model=PortfolioImpact,
)
def research_portfolio_impact(
    ticker: str,
    request: Request,
) -> PortfolioImpact:
    return app_service(request, "research").portfolio_impact(
        ticker,
        latest_or_503(request),
    )


@router.get(
    "/v1/research/{ticker}/alerts",
    response_model=list[ResearchAlert],
)
def research_alerts(ticker: str, request: Request) -> list[ResearchAlert]:
    return app_service(request, "research").alerts(
        ticker,
        latest_or_503(request),
    )


@router.get(
    "/v1/research/{ticker}/lens/{view}",
    response_model=ResearchLensSnapshot,
)
def research_lens(
    ticker: str,
    view: ResearchLensName,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> ResearchLensSnapshot:
    return request.app.state.cached_research_lens(
        latest_or_503(request),
        ticker=ticker,
        view=view,
        limit=limit,
    )


@router.get(
    "/v1/research/{ticker}",
    response_model=ResearchTickerSnapshot,
)
def research_ticker(
    ticker: str,
    request: Request,
) -> ResearchTickerSnapshot:
    return app_service(request, "research").ticker_snapshot(
        ticker,
        latest_or_503(request),
    )
