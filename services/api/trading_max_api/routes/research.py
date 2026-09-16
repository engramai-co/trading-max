"""Expose research directory, shell, lens, and price-series endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from trading_max.research.facts import fingerprint, number
from trading_max.research.valuation_preview import (
    AssumptionReference,
    FrozenValuationBasis,
    ScenarioInputs,
    ValuationPreview,
    ValuationPreviewRequest,
    preview,
)

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
from ..research_funds import FundResearch
from ..research_journal import ResearchJournal, ResearchNoteInput
from ..watchlist import SecuritySearchError
from .dependencies import app_service, latest_or_503, require_write_auth


def _valuation_preview(
    ticker: str, request: Request, inputs: ValuationPreviewRequest | None = None
) -> ValuationPreview:
    lens = app_service(request, "research").lens_snapshot(
        ticker, "valuation", latest_or_503(request)
    )
    facts, context = lens.financial_facts, lens.context
    if not facts or not context or not lens.valuation:
        raise HTTPException(status_code=422, detail="valuation-inputs-unavailable")
    if context.asset_type in {"ETF", "MUTUALFUND"} or any(
        c.reason == "financial-company-requires-equity-model" for c in context.capabilities
    ):
        raise HTTPException(status_code=422, detail="cashflow-model-not-applicable")
    observations = {o.metric: o for o in facts.observations if o.period_id == facts.latest_ttm}
    revenue, fcf = observations.get("revenue"), observations.get("freeCashflow")
    stored = lens.valuation.assumptions
    shares = number(stored.get("sharesOutstanding"))
    quote = context.quote
    if (
        not quote.currency
        or not facts.currency
        or not quote.price
        or not revenue
        or not revenue.value
        or not fcf
        or fcf.value is None
        or not shares
    ):
        raise HTTPException(
            status_code=422, detail="complete-ttm-currency-and-share-count-required"
        )
    fx = 1 if facts.currency == quote.currency else number(stored.get("fxRate"))
    if not fx or fx <= 0:
        raise HTTPException(status_code=422, detail="currency-conversion-unavailable")
    basis = FrozenValuationBasis(
        ticker=ticker,
        quote_id=quote.id,
        data_version=fingerprint([facts.version, quote.id]),
        currency=quote.currency,
        spot=quote.price,
        revenue=revenue.value * fx,
        shares=shares,
        start_margin=fcf.value / revenue.value,
        evidence=[*revenue.evidence, *fcf.evidence],
    )
    if inputs is None:
        references = []
        try:
            scenarios = {
                key: ScenarioInputs.model_validate(
                    value.model_dump(
                        exclude_none=True,
                        include={
                            "revenue_cagr",
                            "target_fcf_margin",
                            "discount_rate",
                            "exit_fcf_multiple",
                            "share_cagr",
                        },
                    )
                )
                for key, value in lens.valuation.scenarios.items()
            }
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail="complete-scenario-assumptions-required"
            ) from exc
        if stored.get("assumptionSource") == "sector-template":
            annual = sorted(
                (p for p in facts.periods if p.kind == "annual"), key=lambda p: p.provider_end
            )[-4:]
            revenues = {
                o.period_id: o
                for o in facts.observations
                if o.metric == "revenue" and o.value is not None and o.value > 0
            }
            annual = [p for p in annual if p.id in revenues]
            if len(annual) < 2:
                raise HTTPException(status_code=422, detail="explicit-growth-assumption-required")
            from datetime import date

            duration = (
                date.fromisoformat(annual[-1].provider_end)
                - date.fromisoformat(annual[0].provider_end)
            ).days / 365.25
            first, last = revenues[annual[0].id], revenues[annual[-1].id]
            growth = (last.value / first.value) ** (1 / duration) - 1
            for key, delta in (("bear", -0.05), ("base", 0), ("bull", 0.05)):
                if key in scenarios:
                    scenarios[key] = scenarios[key].model_copy(
                        update={"revenue_cagr": max(-0.3, min(0.8, growth + delta))}
                    )
                    references.append(
                        AssumptionReference(
                            scenario=key,
                            period=f"{annual[0].label} → {annual[-1].label}",
                            as_of=annual[-1].actual_end or annual[-1].provider_end,
                            value=scenarios[key].revenue_cagr,
                            reference_value=growth,
                            adjustment=scenarios[key].revenue_cagr - growth,
                            source="historical-revenue-cagr",
                            evidence=[*first.evidence, *last.evidence],
                        )
                    )
        configured = app_service(request, "valuation_assumptions").load()
        company = next(
            (c for c in configured.companies if c.ticker.upper() == ticker.upper()), None
        )
        if company and company.source == "manual":
            references = []
            for key, value in company.scenarios.items():
                if key in scenarios:
                    scenarios[key] = ScenarioInputs.model_validate(
                        {
                            **scenarios[key].model_dump(),
                            **value.model_dump(
                                exclude_none=True, include=set(ScenarioInputs.model_fields)
                            ),
                        }
                    )
        saved = app_service(request, "research_journal").load(ticker).models
        inputs = (
            ValuationPreviewRequest(
                scenarios={k: v.inputs for k, v in saved[0].preview.scenarios.items()},
                horizon=saved[0].preview.horizon,
                references=saved[0].preview.references,
            )
            if saved
            else ValuationPreviewRequest(scenarios=scenarios, references=references)
        )
    try:
        return preview(basis, inputs)
    except ValueError as exc:
        raise HTTPException(
            status_code=409 if str(exc) == "research-data-version-changed" else 422, detail=str(exc)
        ) from exc


router = APIRouter(tags=["research"])


@router.get("/v1/research/{ticker}/valuation-preview", response_model=ValuationPreview)
def valuation_preview_defaults(ticker: str, request: Request) -> ValuationPreview:
    return _valuation_preview(ticker, request)


@router.post("/v1/research/{ticker}/valuation-preview", response_model=ValuationPreview)
def valuation_preview_calculate(
    ticker: str, body: ValuationPreviewRequest, request: Request
) -> ValuationPreview:
    # Pure computation: this does not refresh providers, change assumptions, or
    # save a model. The explicit save endpoint remains separate and authorized.
    return _valuation_preview(ticker, request, body)


@router.get("/v1/research/{ticker}/journal", response_model=ResearchJournal)
def research_journal(ticker: str, request: Request) -> ResearchJournal:
    return app_service(request, "research_journal").load(ticker)


@router.post(
    "/v1/research/{ticker}/journal",
    response_model=ResearchJournal,
    dependencies=[Depends(require_write_auth)],
)
def research_note_create(ticker: str, body: ResearchNoteInput, request: Request) -> ResearchJournal:
    try:
        return app_service(request, "research_journal").save_note(ticker, body)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put(
    "/v1/research/{ticker}/journal/{note_id}",
    response_model=ResearchJournal,
    dependencies=[Depends(require_write_auth)],
)
def research_note_update(
    ticker: str, note_id: str, body: ResearchNoteInput, request: Request
) -> ResearchJournal:
    try:
        return app_service(request, "research_journal").save_note(ticker, body, note_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post(
    "/v1/research/{ticker}/models",
    response_model=ResearchJournal,
    dependencies=[Depends(require_write_auth)],
)
def research_model_save(
    ticker: str, body: ValuationPreviewRequest, request: Request
) -> ResearchJournal:
    result = _valuation_preview(ticker, request, body)
    return app_service(request, "research_journal").save_model(result)


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
    interval: Literal["15m", "60m", "1d", "1wk"] = "1d",
) -> ResearchPriceSeries:
    import re

    if not re.fullmatch(r"[A-Za-z0-9^=._-]{1,32}", ticker):
        raise HTTPException(status_code=422, detail="invalid-security-symbol")
    fallback_reason = None
    if interval != "1d":
        try:
            result = app_service(request, "security_prices").get(ticker, interval)
            result.points = result.points[-limit:]
            try:
                daily = app_service(request, "research").price_series(
                    ticker, latest_or_503(request), limit=2_000
                )
                visible_dates = {p.date[:10] for p in result.points}
                result.trade_markers = [
                    m for m in daily.trade_markers if m.date[:10] in visible_dates
                ]
            except FileNotFoundError:
                pass
            return result
        except Exception:
            fallback_reason = "requested-interval-unavailable-daily-history-retained"
    try:
        result = app_service(request, "research").price_series(
            ticker, latest_or_503(request), limit=limit
        )
        result.requested_interval = interval
        result.coverage_reason = fallback_reason
        return result
    except FileNotFoundError as exc:
        try:
            result = app_service(request, "security_prices").get(ticker, "1d")
            result.requested_interval = interval
            result.coverage_reason = fallback_reason
            result.points = result.points[-limit:]
            return result
        except Exception:
            raise HTTPException(
                status_code=404, detail="security-price-history-unavailable"
            ) from exc


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


@router.get("/v1/research/{ticker}/fund", response_model=FundResearch)
def research_fund(ticker: str, request: Request) -> FundResearch:
    lens = app_service(request, "research").lens_snapshot(
        ticker, "fundamentals", latest_or_503(request)
    )
    if not lens.context or lens.context.asset_type not in {"ETF", "MUTUALFUND"}:
        raise HTTPException(status_code=422, detail="fund-research-not-applicable")
    info = (lens.fundamentals or {}).get("metrics") or {}
    return app_service(request, "research_funds").get(ticker, info)
