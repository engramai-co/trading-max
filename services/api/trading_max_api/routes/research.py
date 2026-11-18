"""Expose research directory, shell, lens, and price-series endpoints."""

from __future__ import annotations

import logging
from contextlib import suppress
from datetime import UTC, datetime
from time import perf_counter
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from trading_max.analytics.etf_details import ETFDetail
from trading_max.analytics.etf_journal import ETF_JOURNAL_KEY, ETFDisclosure
from trading_max.analytics.etf_peers import ETFPeerComparison
from trading_max.domain.etf_depth import ETF_PEERS_KEY, HMRC_REPORTING_KEY, UKReportingFund
from trading_max.infrastructure.alpaca_market_prices import is_alpaca_listing
from trading_max.reference.fund_benchmarks import US_FUND_ISINS, london_fund_benchmark
from trading_max.research.estimate_history import MAX_HISTORY_ROWS, EstimateObservation
from trading_max.research.facts import fingerprint, number
from trading_max.research.fund_references import us_fund, us_fund_listing
from trading_max.research.valuation_preview import (
    AssumptionReference,
    FrozenValuationBasis,
    ScenarioInputs,
    ValuationPreview,
    ValuationPreviewRequest,
    preview,
)
from trading_max.research.venues import VenueConflict, row_claims

from ..dashboard_models import (
    PriceSeriesPoint,
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchPriceSeries,
    ResearchShell,
)
from ..etf_snapshot import find_etf, read_etf_detail, read_etf_portfolio
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
from ..research_funds import FundResearch, benchmark_fields, fund_research_from_snapshot
from ..research_journal import ResearchJournal, ResearchModelSaveRequest, ResearchNoteInput
from ..research_public import public_lens
from ..watchlist import SecuritySearchError
from .dependencies import app_service, latest_or_503, require_write_auth

LOGGER = logging.getLogger(__name__)


def _valuation_preview(
    ticker: str, request: Request, inputs: ValuationPreviewRequest | None = None
) -> ValuationPreview:
    default_source = "user-input"
    research = app_service(request, "research")
    manifest = latest_or_503(request)
    lens = research.lens_snapshot(ticker, "valuation", manifest)
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
    # The data version stays tied to the research quote so a broker refresh
    # never invalidates an edit in progress.
    held = research.held_position(ticker, manifest)
    # Only the same listing in the same currency: a line on another market or a
    # ``.L`` alias is a different price, even in the quote's currency.
    broker_spot = (
        held is not None
        and held.get("listing") is not None
        and held["listing"] == quote.listing
        and held["currency"] == quote.currency
    )
    basis = FrozenValuationBasis(
        ticker=ticker,
        quote_id=quote.id,
        data_version=fingerprint([facts.version, quote.id]),
        currency=quote.currency,
        spot=held["price"] if broker_spot else quote.price,
        spot_source="broker" if broker_spot else "quote",
        spot_as_of=held["asOf"] if broker_spot else quote.as_of,
        revenue=revenue.value * fx,
        shares=shares,
        start_margin=fcf.value / revenue.value,
        evidence=[*revenue.evidence, *fcf.evidence],
    )
    if inputs is None:
        default_source = (
            "sector-template"
            if stored.get("assumptionSource") == "sector-template"
            else "configured-scenarios"
        )
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
            default_source = "configured-scenarios"
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
        if saved:
            default_source = "saved-model"
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
        result = preview(basis, inputs)
        result.default_source = default_source
        return result
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
    ticker: str, body: ResearchModelSaveRequest, request: Request
) -> ResearchJournal:
    inputs = ValuationPreviewRequest.model_validate(body.model_dump(exclude={"reason"}))
    result = _valuation_preview(ticker, request, inputs)
    return app_service(request, "research_journal").save_model(result, body.reason)


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
    "/v1/research/{ticker}/estimate-history",
    response_model=list[EstimateObservation],
)
def research_estimate_history(
    ticker: str,
    request: Request,
    limit: Annotated[int, Query(ge=1, le=MAX_HISTORY_ROWS)] = 504,
) -> list[EstimateObservation]:
    """Return the latest observations for an exact ticker, oldest first."""
    return app_service(request, "estimate_history").list(ticker, limit=limit)


@router.get(
    "/v1/research/{ticker}/prices",
    response_model=ResearchPriceSeries,
)
def research_prices(
    ticker: str,
    request: Request,
    limit: Annotated[int, Query(ge=2, le=2_000)] = 504,
    interval: Literal["15m", "60m", "1d", "1wk"] = "1d",
    window: Literal["3M"] | None = None,
) -> ResearchPriceSeries:
    import re

    from ..research_prices import price_window

    if not re.fullmatch(r"[A-Za-z0-9^=._-]{1,32}", ticker):
        raise HTTPException(status_code=422, detail="invalid-security-symbol")
    manifest = latest_or_503(request)
    research = app_service(request, "research")
    ticker = ticker.upper()
    exchanges = research.watchlist.listing_exchanges()
    pinned = research.pin_listing(ticker, manifest, exchanges=exchanges)
    if pinned.venue().conflict:
        raise HTTPException(status_code=404, detail="published_daily_bars_unavailable")
    listing = pinned.held
    # Comparison ETFs and confirmed held US ETF listings use Alpaca's price
    # chart. The typed snapshot remains the source for broker events and research.
    symbol = pinned.symbol
    reference = us_fund(symbol) if listing is None else None
    market_etf = is_alpaca_listing(symbol) and (
        reference is not None
        or symbol in {"SPY", "VOO", "QQQ", "VT"}
        or (listing is not None and us_fund_listing(listing))
    )
    security_prices = app_service(request, "security_prices")

    def live_window(series: ResearchPriceSeries) -> ResearchPriceSeries:
        try:
            venue = research.price_venue(pinned, series)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        series.exchange_calendar = venue.calendar
        series.points = series.points[-limit:]
        series.coverage_start = series.points[0].date if series.points else None
        series.coverage_end = series.points[-1].date if series.points else None
        markers, _ = research.trade_markers(manifest, series.ticker, series.currency)
        visible_dates = {point.date[:10] for point in series.points}
        series.trade_markers = [marker for marker in markers if marker.date in visible_dates]
        return price_window(series, window)

    if market_etf:
        result = security_prices.alpaca_etf(symbol, interval)
        if result is not None:
            return live_window(result)
    if reference is not None:
        # Prefer the listing's published technical history when it was researched
        # directly. Otherwise use the shared close-only chart and budget.
        try:
            published = research.price_series(ticker, manifest, limit=limit, pinned=pinned)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        except FileNotFoundError:
            published = None
        if published:
            published.requested_interval = interval
            published.coverage_reason = (
                "requested-interval-unavailable-daily-history-retained"
                if interval != "1d"
                else None
            )
            published.coverage_start = published.points[0].date if published.points else None
            published.coverage_end = published.points[-1].date if published.points else None
            return price_window(published, window)
        try:
            public = security_prices.get(reference.ticker, "1d", market_etf=True)
            public.requested_interval = interval
            public.coverage_reason = (
                "requested-interval-unavailable-daily-history-retained"
                if interval != "1d"
                else None
            )
            return live_window(public)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        except HTTPException:
            raise
        except Exception:
            LOGGER.debug("Public OHLC history unavailable; trying daily closes")
        try:
            series = app_service(request, "market_prices").history(reference.ticker)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        except HTTPException:
            raise
        except Exception:
            series = None
        if series is None:
            raise HTTPException(status_code=404, detail="security-price-history-unavailable")
        points = [
            PriceSeriesPoint(
                date=datetime.fromtimestamp(stamp, UTC).date().isoformat(),
                close=close,
                open=None,
                high=None,
                low=None,
                volume=None,
                sma20=None,
                sma50=None,
                sma200=None,
            )
            for stamp, close in zip(series.timestamps, series.closes, strict=True)
            if close is not None
        ]
        if not points:
            raise HTTPException(status_code=404, detail="security-price-history-unavailable")
        return live_window(
            ResearchPriceSeries(
                ticker=reference.ticker,
                currency="USD",
                as_of=points[-1].date,
                requested_interval=interval,
                available_sessions=len(points),
                points=points,
                timezone=series.timezone,
                source=series.source,
                venue_claims=row_claims(
                    series.symbol,
                    {
                        "mic": series.mic,
                        "exchangeName": series.exchange_name,
                        "fullExchangeName": series.full_exchange_name,
                    },
                ),
                adjustment="provider-close",
                fetched_at=series.fetched_at.isoformat() if series.fetched_at else None,
                coverage_reason="requested-interval-unavailable-daily-history-retained"
                if interval != "1d"
                else None,
            ),
        )
    fallback_reason = None
    if interval != "1d":
        try:
            result = security_prices.get(symbol, interval, market_etf=market_etf)
            return live_window(result)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        except HTTPException:
            raise
        except Exception:
            fallback_reason = "requested-interval-unavailable-daily-history-retained"
    try:
        result = research.price_series(ticker, manifest, limit=limit, pinned=pinned)
        result.requested_interval = interval
        result.coverage_reason = fallback_reason
        result.coverage_start = result.points[0].date if result.points else None
        result.coverage_end = result.points[-1].date if result.points else None
        return price_window(result, window)
    except VenueConflict as exc:
        raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
    except FileNotFoundError as exc:
        try:
            result = security_prices.get(
                symbol, "1d", preview=window == "3M", market_etf=market_etf
            )
            result.requested_interval = interval
            result.coverage_reason = fallback_reason
            return live_window(result)
        except VenueConflict as exc:
            raise HTTPException(status_code=404, detail="published_daily_bars_unavailable") from exc
        except HTTPException:
            raise
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
    response: Response,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    detail: Literal["full", "summary", "seasonality", "documents"] = "full",
    preview: bool = False,
) -> ResearchLensSnapshot:
    if preview:
        manifest = latest_or_503(request)
        try:
            security = app_service(request, "security_search").exact(ticker)
        except SecuritySearchError as exc:
            raise HTTPException(status_code=502, detail="security-search-unavailable") from exc
        if security is None:
            raise HTTPException(status_code=404, detail="unknown-security-listing")
        return public_lens(
            security,
            view,
            detail,
            manifest,
            app_service(request, "security_prices"),
            app_service(request, "research").pin_listing(ticker, manifest),
        )
    started = perf_counter()
    diagnostics: dict[str, str] = {}
    payload = request.app.state.cached_research_lens(
        latest_or_503(request),
        ticker=ticker,
        view=view,
        limit=limit,
        detail=detail,
        diagnostics=diagnostics,
    )
    response.headers["Server-Timing"] = (
        f'research_lens;dur={(perf_counter() - started) * 1000:.1f}, research_cache;desc="{diagnostics.get("cache", "unknown")}"'
    )
    return payload


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
def research_fund(
    ticker: str,
    request: Request,
    run_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    detail: Literal["profile", "full", "journal", "peers", "tracking"] = "full",
) -> FundResearch:
    store = app_service(request, "store")
    try:
        manifest = store.load_manifest(run_id) if run_id else latest_or_503(request)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="snapshot not found") from None
    research = app_service(request, "research")
    listing = research.held_fund(ticker, manifest)
    # A US reference can share its ticker with a different London ETF. It
    # has curated identity evidence and needs no issuer request to open.
    reference = us_fund(ticker)
    if reference and not listing:
        isin = US_FUND_ISINS.get(reference.ticker)
        fund = FundResearch(
            ticker=reference.ticker,
            isin=isin,
            **benchmark_fields(isin),
            fetched_at="",
            index_name=reference.benchmark,
            source_url=reference.source_url,
            share_currency="USD",
            domicile="US",
            state="available",
        )
        return (
            app_service(request, "research_funds").with_daily_tracking(fund)
            if detail in {"full", "tracking"}
            else fund
        )
    portfolio = read_etf_portfolio(store, manifest.run_id)
    reading = (
        research.fund_reading(listing, portfolio.funds)
        if listing
        else find_etf(portfolio.funds, ticker)
    )
    if reading:
        isin = reading.isin
        try:
            snapshot = (
                read_etf_detail(
                    store,
                    manifest.run_id,
                    isin,
                    include_holdings=detail in {"profile", "full", "tracking"},
                )
                if isin
                else ETFDetail(reading=reading)
            )
        except FileNotFoundError:
            snapshot = ETFDetail(reading=reading)
        fund = fund_research_from_snapshot(
            listing.ticker if listing else ticker, snapshot, include_holdings=detail == "full"
        )
        if detail == "journal":
            try:
                journal = store.read_json(manifest.run_id, ETF_JOURNAL_KEY)
            except FileNotFoundError:
                journal = {}
            fund.disclosures = [ETFDisclosure.model_validate(row) for row in journal.get(isin, [])]
        if isin and detail in {"profile", "full"}:
            with suppress(FileNotFoundError, KeyError):
                status = store.read_json(manifest.run_id, HMRC_REPORTING_KEY).get(isin)
                if status is not None:
                    fund.uk_reporting_fund = UKReportingFund.model_validate(status)
        if isin and detail == "peers":
            with suppress(FileNotFoundError, KeyError):
                comparison = store.read_json(manifest.run_id, ETF_PEERS_KEY).get(isin)
                if comparison is not None:
                    fund.peer_comparison = ETFPeerComparison.model_validate(comparison)
        return (
            app_service(request, "research_funds").with_daily_tracking(fund)
            if detail in {"full", "tracking"}
            else fund
        )
    if listing:
        # Held fund lenses use the account publication, never a second issuer fetch.
        return app_service(request, "research_funds").with_daily_tracking(
            FundResearch(
                ticker=listing.ticker,
                isin=listing.isin or None,
                fetched_at="",
                state="pending",
                **benchmark_fields(listing.isin),
            )
        )
    lens = research.lens_snapshot(ticker, "fundamentals", manifest)
    info = (lens.fundamentals or {}).get("metrics") or {}
    curated = london_fund_benchmark(ticker)
    if curated is not None and not info.get("isin"):
        info = {**info, "isin": curated.isin}
    if not lens.context or lens.context.asset_type not in {"ETF", "MUTUALFUND"}:
        search = app_service(request, "security_search")
        try:
            security = search.exact(ticker)
        except SecuritySearchError:
            security = None
        if not security or (security.security_type or "").upper() not in {
            "ETF",
            "ETP",
            "MUTUALFUND",
        }:
            raise HTTPException(status_code=422, detail="fund-research-not-applicable")
        info = {**info, "longName": security.name}
    if detail in {"journal", "peers"}:
        return FundResearch(ticker=ticker, isin=info.get("isin"), fetched_at="")
    service = app_service(request, "research_funds")
    fund = service.get(ticker, info)
    if detail in {"full", "tracking"}:
        fund = service.with_daily_tracking(fund)
    return fund if detail == "full" else fund.model_copy(update={"holdings": None})
