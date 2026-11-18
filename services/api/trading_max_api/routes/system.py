"""Expose health, readiness, dashboard lenses, snapshots, and artifacts."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from trading_max.analytics.etf_details import ETFDetail
from trading_max.analytics.etf_projection import ETFPortfolio
from trading_max.analytics.review_evidence import (
    AccountReviewEvidence,
    InvestmentReviewEvidence,
    ReviewRules,
)
from trading_max.application.decision_stages import REVIEW_EVIDENCE_KEY
from trading_max.infrastructure import SnapshotIntegrityError
from trading_max.research.calendars.refresh import MACRO_KEY, MACRO_STATUS_KEY
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY

from ..artifacts import ArtifactStore
from ..dashboard import (
    benchmark_series,
    published_broker,
    published_lookthrough,
    published_positions,
    risk_metrics,
)
from ..dashboard_models import (
    AccountCode,
    AccountDecisions,
    BenchmarkPricePoint,
    DashboardLensName,
    DashboardLensSnapshot,
    DashboardResponse,
    DayAttribution,
    InvestableAccountCode,
    NavPoint,
    OverviewReviewSummary,
    TradeDecision,
    WindowAttribution,
)
from ..etf_snapshot import read_etf_detail, read_etf_portfolio
from ..history_projection import HistoryRange, HistoryScope, project_intraday, scope_points
from ..history_reader import HistorySnapshot, daily_nav
from ..models import HealthResponse, ReadinessResponse, SnapshotManifest
from ..projections.broker import positions_observed_at
from ..projections.day_change import within_trading_days
from ..projections.values import number_value
from .dependencies import app_service, latest_or_503

router = APIRouter()

_EMPTY_STORE_BOOTSTRAP_ERROR = "FileNotFoundError: no typed snapshot has been published"
_PORTFOLIO_TIME_ZONE = ZoneInfo("Europe/London")


def researched_holdings(holdings) -> set[str]:
    """Include technical readings published under old display symbols or exact listings."""
    return {holding.ticker for holding in holdings} | {
        holding.research_ticker for holding in holdings if holding.research_ticker
    }


def _portfolio_day(value: str) -> date | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(_PORTFOLIO_TIME_ZONE).date()


def _day_attribution(request: Request, run_id: str) -> DayAttribution | None:
    """Optional: older snapshots and unreconciled days have no attribution.

    Accounts measured from an opening on another trading day are left out.
    """

    try:
        payload = request.app.state.store.read_json(run_id, "account/attribution/day.json")
        return DayAttribution.model_validate(within_trading_days(payload))
    except (FileNotFoundError, TypeError, ValueError):
        return None


def _window_attribution(request: Request, run_id: str) -> WindowAttribution | None:
    """Optional like the day attribution; snapshots before 5D attribution have none.

    Accounts whose chain starts before the window are left out.
    """

    try:
        payload = request.app.state.store.read_json(run_id, "account/attribution/window.json")
        return WindowAttribution.model_validate(within_trading_days(payload))
    except (FileNotFoundError, TypeError, ValueError):
        return None


def _decision_reviews(request: Request, run_id: str) -> dict[str, AccountDecisions]:
    """Optional: snapshots from before decision review publish none."""

    try:
        payload = request.app.state.store.read_json(run_id, "account/decisions.json")
        return {
            code: AccountDecisions.model_validate(review)
            for code, review in (payload.get("accounts") or {}).items()
            if code in {"A", "B"}
        }
    except (FileNotFoundError, TypeError, ValueError, AttributeError):
        return {}


def _review_evidence(
    request: Request, run_id: str, accounts: list[InvestableAccountCode]
) -> InvestmentReviewEvidence:
    try:
        payload = app_service(request, "store").read_json(run_id, REVIEW_EVIDENCE_KEY)
        saved = InvestmentReviewEvidence.model_validate(payload)
    except (FileNotFoundError, TypeError, ValueError):
        saved = InvestmentReviewEvidence(rules=ReviewRules.current(), accounts={})
    selected = {
        code: saved.accounts.get(code, AccountReviewEvidence(coverage="partial"))
        for code in accounts
    }
    if saved.rules.session_move_volatility is None:
        # Carried-forward rows used the fixed floor alone. Preserve other
        # observations but wait for a replay before showing new move evidence.
        selected = {
            code: evidence.model_copy(update={"holding_moves": [], "coverage": "partial"})
            for code, evidence in selected.items()
        }
        return InvestmentReviewEvidence(rules=ReviewRules.current(), accounts=selected)
    return InvestmentReviewEvidence(rules=saved.rules, accounts=selected)


def _observing(decision: TradeDecision) -> bool:
    """No close has followed the decision; older artifacts say so by having no return."""

    if decision.observed_days is not None:
        return decision.observed_days < 1
    return decision.return_to_date is None


def _review_index(review: AccountDecisions, keep: int = 8) -> AccountDecisions:
    """Every decision, which the review's timeline plots, with its latest round trips and closed trades."""

    return review.model_copy(
        update={
            "observing_count": sum(1 for row in review.decisions if _observing(row)),
            "round_trips": review.round_trips[-keep:],
            "closed_trades": review.closed_trades[:3],
        }
    )


def _artifact_generated_at(manifest: SnapshotManifest, key: str) -> str | None:
    """When an artifact was built; a snapshot can carry it forward from an earlier run."""

    artifact = next((item for item in manifest.artifacts if item.key == key), None)
    if artifact is None or artifact.generated_at is None:
        return None
    return artifact.generated_at.isoformat()


def _latest_intraday_points(points: list[NavPoint]) -> list[NavPoint]:
    """Return only the newest London portfolio day used by the 1D charts."""

    dated = [(point, _portfolio_day(point.date)) for point in points]
    latest_day = max((day for _, day in dated if day is not None), default=None)
    return [point for point, day in dated if latest_day is not None and day == latest_day]


def _benchmark_series_for_nav(
    nav: list[NavPoint],
    series: dict[str, list[BenchmarkPricePoint]],
) -> dict[str, list[BenchmarkPricePoint]]:
    """Discard benchmark history that cannot align with the account NAV."""

    daily_dates = [point.date[:10] for point in nav if not point.intraday]
    if not daily_dates:
        return {}
    first_date = min(daily_dates)
    last_date = max(daily_dates)
    return {
        ticker: [point for point in points if first_date <= point.date[:10] <= last_date]
        for ticker, points in series.items()
    }


def _retained_analytics(
    store: ArtifactStore, manifest: SnapshotManifest, scope: str, projection: str
) -> DashboardLensSnapshot:
    run = manifest.run_id
    broker = store.read_json(run, "account/broker_snapshot_metrics.json")
    try:
        nav = daily_nav(store, manifest, broker["accounts"], scope=scope)
    except FileNotFoundError:
        raise HTTPException(404, "Cited account history unavailable") from None
    risk = projection == "risk"
    fields = {"date", "flow_status", "intraday", scope, scope + "_twr"}
    if risk:
        fields.add(scope + "_drawdown")
    omit = {key: None for key in NavPoint.model_fields if key not in fields}
    base = {
        "view": "analytics",
        "run_id": run,
        "generated_at": manifest.created_at.isoformat(),
        "broker_as_of": str(broker.get("generated_at_utc") or ""),
        "nav": [p.model_copy(update=omit) for p in nav],
    }
    if risk:
        try:
            metrics = store.read_json(run, "account/synthetic_nav_metrics.json")
        except FileNotFoundError:
            metrics = {}
        codes = ("A", "B") if scope == "total" else ("A",) if scope == "invest" else ("B",)
        return DashboardLensSnapshot(
            **base,
            research_as_of="",
            risk={
                code: risk_metrics(metrics[code])
                for code in codes
                if code in broker["accounts"] and code in metrics
            },
        )
    try:
        technical = store.read_json(run, "research/technical.json")
    except FileNotFoundError:
        technical = {}
    series = {
        ticker: [BenchmarkPricePoint.model_validate(p) for p in points]
        for ticker, points in benchmark_series(technical).items()
    }
    return DashboardLensSnapshot(
        **base,
        research_as_of=str(technical.get("as_of") or ""),
        benchmark_series=_benchmark_series_for_nav(nav, series),
    )


def _retained_holdings(store, manifest, view, account):
    run = manifest.run_id
    base = {
        "view": view,
        "run_id": run,
        "generated_at": manifest.created_at.isoformat(),
        "research_as_of": "",
    }
    try:
        lookthrough = published_lookthrough(store, run)
    except FileNotFoundError:
        if view == "holdings-lookthrough":
            raise HTTPException(404, "Cited allocation unavailable") from None
        lookthrough = {}
    if view == "holdings-lookthrough":
        return DashboardLensSnapshot(
            **base, broker_as_of=lookthrough.get("brokerAsOf") or "", lookthrough=lookthrough
        )
    broker = published_broker(store, run)
    accounts = broker["accounts"]
    investable = [code for code in ("A", "B") if code in accounts]
    selected = [code for code in investable if account is None or code == account]
    total = sum(number_value(accounts[code].get("total_value_gbp")) for code in investable)
    return DashboardLensSnapshot(
        **base,
        broker_as_of=(
            accounts.get(account, {}).get("fetched_at")
            or accounts.get(account, {}).get("fetched_at_utc")
            or ""
        )
        if account
        else broker.get("generated_at_utc") or "",
        position_as_of={code: positions_observed_at(accounts[code]) for code in selected},
        holdings=published_positions(store, run, broker, selected, total, lookthrough),
        total_invested_gbp=sum(
            number_value(accounts[c].get("investments_value_gbp")) for c in selected
        ),
        total_unrealized_pnl_gbp=sum(
            number_value(accounts[c].get("unrealized_profit_loss_gbp")) for c in selected
        ),
    )


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


def _event_health(store, latest):
    if not latest:
        return []
    refs = {a.key: a for a in latest.artifacts}
    result = []
    for kind, key, status, collection in [
        ("news", NEWS_KEY, NEWS_STATUS_KEY, "securities"),
        ("macro", MACRO_KEY, MACRO_STATUS_KEY, "sources"),
    ]:
        ref = refs.get(status) or refs.get(key)
        if not ref:
            continue
        attempts = {}
        if ref.warnings:
            try:
                rows = store.read_json(latest.run_id, ref.key).get(collection, {})
            except (FileNotFoundError, SnapshotIntegrityError, TypeError, ValueError):
                rows = {}
            for name in ref.warnings:
                row = rows.get(name, {})
                # Health is available before login. A failed news listing must
                # never expose a holding or watchlist symbol here.
                label = (
                    "Yahoo Finance"
                    if kind == "news"
                    else (f"{row['publisher']} ({name})" if row.get("publisher") else name)
                )
                attempts[label] = max(attempts.get(label, ""), row.get("checked_at") or "")
        result.append(
            {
                "kind": kind,
                "checked_at": ref.generated_at,
                "as_of": ref.data_as_of,
                "failed_sources": len(ref.warnings),
                "failures": [
                    {"source": label, "checked_at": stamp or None}
                    for label, stamp in attempts.items()
                ],
            }
        )
    return result


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
        event_refreshes=_event_health(store, latest),
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


@router.get("/v1/dashboard/etfs", response_model=ETFPortfolio, response_model_exclude_none=True)
def dashboard_etfs(
    request: Request,
    run_id: str = Query(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
) -> ETFPortfolio:
    store = app_service(request, "store")
    try:
        store.load_manifest(run_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="snapshot not found") from None
    return read_etf_portfolio(store, run_id)


@router.get("/v1/dashboard/etfs/{isin}", response_model=ETFDetail, response_model_exclude_none=True)
def dashboard_etf_detail(
    request: Request,
    isin: str,
    run_id: str = Query(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
) -> ETFDetail:
    import re

    if not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", isin):
        raise HTTPException(status_code=404, detail="ETF evidence not found")
    try:
        return read_etf_detail(app_service(request, "store"), run_id, isin)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="ETF evidence not found") from None


def _dashboard_manifest(request: Request, run_id: str | None) -> SnapshotManifest:
    if run_id is None:
        return latest_or_503(request)
    try:
        # Retention can prune a cached publication in the separate worker process.
        return app_service(request, "store").load_manifest(run_id, require_retained=True)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="snapshot not found") from None


def _history_retained(request: Request, manifest: SnapshotManifest) -> bool:
    latest = app_service(request, "store").latest_manifest()
    return not latest or latest.run_id != manifest.run_id


@router.head("/v1/dashboard/history", status_code=204, response_class=Response)
def history_retention(
    request: Request, run_id: str = Query(pattern=r"^[A-Za-z0-9_-]{1,100}$")
) -> Response:
    """Validate a cached chart or exact page without loading its observations."""
    manifest = _dashboard_manifest(request, run_id)
    headers = {"Cache-Control": "private, no-store"}
    if _history_retained(request, manifest):
        headers["X-History-Retained"] = "1"
    return Response(status_code=204, headers=headers)


@router.get(
    "/v1/dashboard/history",
    response_model=HistorySnapshot,
    response_model_exclude_defaults=True,
    response_model_exclude_none=True,
)
def dashboard_history(
    request: Request,
    response: Response,
    range: HistoryRange = "3M",
    scope: HistoryScope = "total",
    run_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$"),
) -> HistorySnapshot:
    manifest = _dashboard_manifest(request, run_id)
    retained = run_id is not None and _history_retained(request, manifest)
    if retained:
        response.headers["X-History-Retained"] = "1"
    reader = "retained_history_reader" if retained else "history_reader"
    try:
        return app_service(request, reader).read(manifest, range, scope)
    except FileNotFoundError:
        detail = "Cited account history unavailable" if retained else "Account history unavailable"
        raise HTTPException(404, detail) from None


@router.get(
    "/v1/dashboard/lens/{view}",
    response_model=DashboardLensSnapshot,
    response_model_exclude_defaults=True,
    response_model_exclude_none=True,
)
def dashboard_lens(
    view: DashboardLensName,
    request: Request,
    run_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    account: AccountCode | None = None,
    range: HistoryRange | None = None,
    scope: HistoryScope | None = None,
    projection: Literal["returns", "risk"] = "returns",
    detail: Literal["full", "summary"] = Query(
        default="full",
        description=(
            "summary returns the page projection without NAV and intraday history; "
            "interactive clients and agents should use it and read history from "
            "/v1/dashboard/history. full (the compatible default) also embeds the "
            "complete history, which grows with every snapshot and can reach many "
            "megabytes on a long-running installation."
        ),
    ),
) -> DashboardLensSnapshot:
    retained_account = (
        run_id is not None
        and view == "account-analysis"
        and detail == "summary"
        and account in {"A", "B"}
        and scope is None
        and range is None
        and projection == "returns"
    )
    if run_id is not None and not retained_account:
        holdings = view in {"holdings-positions", "holdings-lookthrough"}
        valid_holdings = (
            holdings
            and (account is None or (view == "holdings-positions" and account in {"A", "B"}))
            and scope is None
            and projection == "returns"
        )
        valid_analytics = (
            view == "analytics" and account is None and scope in {None, "invest", "isa", "total"}
        )
        if detail != "summary" or not (valid_holdings or valid_analytics):
            raise HTTPException(422, "Unsupported retained dashboard projection")
        manifest = _dashboard_manifest(request, run_id)
        store = app_service(request, "store")
        return request.app.state.retained_lenses.get_or_compute(
            (run_id, view, scope, account, projection),
            lambda: (
                _retained_holdings(store, manifest, view, account)
                if holdings
                else _retained_analytics(store, manifest, scope or "total", projection)
            ),
        )
    manifest = _dashboard_manifest(request, run_id)
    dashboard_data = request.app.state.cached_dashboard(
        manifest, include_history=detail != "summary", retained=retained_account
    )
    base = {
        "view": view,
        "run_id": manifest.run_id,
        "generated_at": dashboard_data.generated_at,
        "broker_as_of": dashboard_data.broker_as_of,
        "research_as_of": dashboard_data.research_as_of,
    }

    if view == "overview":
        held = researched_holdings(dashboard_data.holdings)
        equity_listings = {
            h.research_ticker or h.ticker for h in dashboard_data.holdings if not h.is_fund
        }
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
            day_attribution=_day_attribution(request, manifest.run_id),
            window_attribution=_window_attribution(request, manifest.run_id),
            household_total_value_gbp=dashboard_data.household_total_value_gbp,
            accounts=[item for item in dashboard_data.accounts if item.is_investable],
            cfd=dashboard_data.cfd,
            review_summaries=review_summaries,
            holdings=dashboard_data.holdings,
            technical=[
                item.model_copy(
                    update={
                        "seasonality": [],
                        "seasonality_coverage": {},
                        "seasonality_matrix": [],
                        "year_paths": {},
                        "relative_strength": {},
                        "trend_strength": {},
                    }
                )
                for item in dashboard_data.technical
                if item.ticker in held
            ],
            valuations=[
                app_service(request, "research_journal").overview_valuation(item)
                for item in dashboard_data.valuations
                if item.ticker in equity_listings
            ],
            nav=dashboard_data.nav[-31:],
            intraday_nav=_latest_intraday_points(dashboard_data.intraday_nav),
        )
    if view == "holdings-positions":
        return DashboardLensSnapshot(
            **base,
            position_as_of=dashboard_data.position_as_of,
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
            nav=scope_points(dashboard_data.nav, scope),
            intraday_nav=project_intraday(
                dashboard_data.intraday_nav,
                dashboard_data.nav,
                as_of=dashboard_data.broker_as_of,
                range_name=range,
                scope=scope,
            ),
            risk=dashboard_data.risk,
            benchmark_series=_benchmark_series_for_nav(
                dashboard_data.nav, dashboard_data.benchmark_series
            ),
            policy=dashboard_data.policy,
        )
    if view == "review":
        # The review needs each account's verdict, how many decisions still wait for
        # a close, and every decision for its timeline.
        reviews = {
            code: _review_index(review)
            for code, review in _decision_reviews(request, manifest.run_id).items()
        }
        evidence = _review_evidence(
            request,
            manifest.run_id,
            [item.code for item in dashboard_data.accounts if item.code in {"A", "B"}],
        )
        # A later lightweight snapshot can carry this review forward. Its
        # readings still stop at the account observations used in the replay.
        as_of = min(
            (row.as_of for row in evidence.accounts.values() if row.as_of is not None),
            default=None,
        )
        return DashboardLensSnapshot(
            **base,
            accounts=dashboard_data.accounts,
            cfd=dashboard_data.cfd,
            risk=dashboard_data.risk,
            decision_reviews=reviews,
            review_as_of=as_of.isoformat() if as_of is not None else None,
            review_evidence=evidence,
        )

    selected = account or "A"
    selected_account = next(
        (item for item in dashboard_data.accounts if item.code == selected),
        None,
    )
    if selected_account is None and selected != "C":
        raise HTTPException(status_code=404, detail=f"account {selected} is unavailable")
    selected_review = (
        dashboard_data.account_reviews.get(selected) if selected in {"A", "B"} else None
    )
    return DashboardLensSnapshot(
        **base,
        cfd=dashboard_data.cfd if selected == "C" else None,
        selected_account=selected_account,
        selected_account_analysis=dashboard_data.account_analysis.get(selected),
        selected_account_review=selected_review,
        review_as_of=(
            _artifact_generated_at(manifest, "account/account_reviews.json")
            if selected_review is not None
            else None
        ),
        selected_cfd_review=(dashboard_data.cfd_review if selected == "C" else None),
        selected_account_report=dashboard_data.account_report.analysis.get(selected, {}),
        selected_account_decisions=(
            _decision_reviews(request, manifest.run_id).get(selected)
            if selected in {"A", "B"}
            else None
        ),
        review_evidence=(
            _review_evidence(request, manifest.run_id, [selected])
            if selected in {"A", "B"}
            else None
        ),
        selected_risk=(dashboard_data.risk.get(selected) if selected in {"A", "B"} else None),
        holdings=[holding for holding in dashboard_data.holdings if holding.account == selected],
        nav=dashboard_data.nav,
        intraday_nav=dashboard_data.intraday_nav if detail == "full" else [],
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
def latest_artifact(artifact_key: str, request: Request) -> Response:
    try:
        path, artifact = app_service(request, "store").latest_artifact_path(
            artifact_key,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    store = app_service(request, "store").immutable_artifacts
    if artifact.media_type == "application/json":
        store.get_ref(path.name)
        return Response(
            content=store.content_bytes(path.name),
            media_type=artifact.media_type,
            headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
        )
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
) -> Response:
    try:
        path, artifact = app_service(request, "store").artifact_path(
            run_id,
            artifact_key,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    store = app_service(request, "store").immutable_artifacts
    if artifact.media_type == "application/json":
        store.get_ref(path.name)
        return Response(
            content=store.content_bytes(path.name),
            media_type=artifact.media_type,
            headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
        )
    return FileResponse(
        path,
        media_type=artifact.media_type,
        filename=path.name,
    )
