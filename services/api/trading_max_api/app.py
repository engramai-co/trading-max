"""Assemble the Trading Max API, lifecycle services, and security middleware."""

from __future__ import annotations

import ipaddress
import logging
import os
import threading
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import Request
from trading_max import __version__ as trading_max_version
from trading_max.ingestion.cfd_imports import MAX_CFD_IMPORT_BYTES, CfdImportStore
from trading_max.reference import CatalogSecurityMaster

from .alert_monitor import AlertMonitor, LiveAlertStore
from .artifacts import ArtifactStore
from .config import Settings
from .credentials import (
    CredentialStore,
    default_credential_store,
)
from .dashboard import build_dashboard_data
from .dashboard_models import (
    DashboardResponse,
    ResearchLensName,
    ResearchLensSnapshot,
    ResearchShell,
)
from .intraday_scheduler import IntradayScheduler
from .logging_setup import configure_logging
from .models import ResearchOverview, SnapshotManifest
from .provider_runtime import ProviderRuntimeError, make_provider_factory
from .research import ResearchLedger
from .routes.analysis import router as analysis_router
from .routes.imports import router as imports_router
from .routes.operations import router as operations_router
from .routes.research import router as research_router
from .routes.settings import router as settings_router
from .routes.system import router as system_router
from .scheduler import NightlyScheduler
from .security_entity_resolution import OpenCodeWebSearchResolver
from .settings import SettingsRepository
from .typed_analysis import TypedAnalysisManager
from .typed_jobs import TypedJobManager
from .valuation_assumptions import ValuationAssumptionsStore
from .watchlist import SecuritySearchService, WatchlistStore


def create_app(
    settings: Settings | None = None,
    *,
    credential_store: CredentialStore | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate_runtime_mode()
    logger = configure_logging()
    store = ArtifactStore(settings.data_root)
    preferences = SettingsRepository(settings.data_root)
    automation_preferences = preferences.ensure_automation_preferences(
        nightly_enabled=settings.nightly_enabled,
        intraday_enabled=settings.intraday_enabled,
        performance_enabled=settings.performance_enabled,
        research_enabled=settings.research_enabled,
    )
    credentials = credential_store or default_credential_store()
    validation_secret = (settings.api_token or uuid.uuid4().hex).encode()
    watchlist = WatchlistStore(settings.data_root)
    valuation_assumptions = ValuationAssumptionsStore(settings.data_root)
    live_alerts = LiveAlertStore(settings.data_root)
    cfd_imports = CfdImportStore(settings.data_root)
    research = ResearchLedger(store, watchlist, live_alerts)
    provider_factory = make_provider_factory(
        settings,
        preferences,
        credentials,
    )
    web_entity_resolver = OpenCodeWebSearchResolver(provider_factory)
    security_search = SecuritySearchService(
        watchlist,
        security_master=CatalogSecurityMaster.from_state_root(settings.data_root),
        entity_resolver=web_entity_resolver.resolve,
    )

    dashboard_cache_lock = threading.Lock()
    dashboard_cache: tuple[str, DashboardResponse] | None = None
    research_cache_lock = threading.Lock()
    research_cache_run_id: str | None = None
    research_cache: dict[
        tuple[str, str | None, int, str],
        ResearchOverview,
    ] = {}
    research_shell_cache: dict[tuple[str, str], ResearchShell] = {}
    research_lens_cache: dict[
        tuple[str, str, ResearchLensName, int, str],
        ResearchLensSnapshot,
    ] = {}

    def cached_dashboard(manifest: SnapshotManifest) -> DashboardResponse:
        nonlocal dashboard_cache
        with dashboard_cache_lock:
            if dashboard_cache is not None and dashboard_cache[0] == manifest.run_id:
                return dashboard_cache[1]
            payload = DashboardResponse.model_validate(
                build_dashboard_data(store, manifest),
            )
            dashboard_cache = (manifest.run_id, payload)
            return payload

    def cached_research(
        manifest: SnapshotManifest,
        *,
        ticker: str | None,
        limit: int,
    ) -> ResearchOverview:
        nonlocal research_cache_run_id
        watchlist_revision = watchlist.revision()
        key = (manifest.run_id, ticker, limit, watchlist_revision)
        with research_cache_lock:
            if research_cache_run_id != manifest.run_id:
                research_cache.clear()
                research_cache_run_id = manifest.run_id
            cached = research_cache.get(key)
            if cached is not None:
                return cached
            payload = research.overview(
                manifest,
                ticker=ticker,
                limit=limit,
            )
            if len(research_cache) >= 128:
                research_cache.clear()
            research_cache[key] = payload
            return payload

    def cached_research_shell(manifest: SnapshotManifest) -> ResearchShell:
        watchlist_revision = watchlist.revision()
        key = (manifest.run_id, watchlist_revision)
        with research_cache_lock:
            cached = research_shell_cache.get(key)
        if cached is not None:
            return cached
        payload = research.shell(manifest)
        with research_cache_lock:
            if len(research_shell_cache) >= 32:
                research_shell_cache.clear()
            research_shell_cache[key] = payload
        return payload

    def cached_research_lens(
        manifest: SnapshotManifest,
        *,
        ticker: str,
        view: ResearchLensName,
        limit: int,
    ) -> ResearchLensSnapshot:
        live_revision = live_alerts.revision() if view == "ledger" else ""
        key = (manifest.run_id, ticker.upper(), view, limit, live_revision)
        with research_cache_lock:
            cached = research_lens_cache.get(key)
        if cached is not None:
            return cached
        payload = research.lens_snapshot(ticker, view, manifest, limit=limit)
        with research_cache_lock:
            if len(research_lens_cache) >= 256:
                research_lens_cache.clear()
            research_lens_cache[key] = payload
        return payload

    def prewarm_research() -> None:
        """Populate the current user-facing projections outside request latency."""

        manifest = store.latest_manifest()
        if manifest is None:
            return
        research.prewarm_history()
        shell = cached_research_shell(manifest)
        lens_names: tuple[ResearchLensName, ...] = (
            "overview",
            "technical",
            "valuation",
            "fundamentals",
            "analyst",
            "options",
            "ledger",
        )
        for instrument in shell.instruments:
            if not instrument.held:
                continue
            with suppress(FileNotFoundError):
                research.price_series(instrument.ticker, manifest)
            for lens_name in lens_names:
                with suppress(FileNotFoundError):
                    cached_research_lens(
                        manifest,
                        ticker=instrument.ticker,
                        view=lens_name,
                        limit=30,
                    )

    analysis = TypedAnalysisManager(
        store,
        watchlist,
        provider=settings.llm_provider,
        model=settings.llm_model,
        openai_api_key=settings.openai_api_key,
        openai_base_url=settings.openai_base_url,
        deepseek_api_key=settings.deepseek_api_key,
        deepseek_base_url=settings.deepseek_base_url,
        provider_factory=provider_factory,
    )
    analysis.reload_provider()

    def on_snapshot_published(published, trigger) -> None:
        if trigger in {"intraday", "live"}:
            return
        try:
            analysis.submit(
                lenses=(
                    ["watchlist_opportunity_map"]
                    if published.manifest.scope == "research"
                    else None
                ),
                snapshot_run_id=published.manifest.run_id,
                trigger="nightly" if trigger == "nightly" else "snapshot",
            )
        except ProviderRuntimeError as exc:
            logger.warning(
                "snapshot analysis deferred until a provider is configured",
                extra={"provider_error_code": exc.code},
            )

    jobs = TypedJobManager(
        store,
        watchlist,
        intraday_interval_seconds=settings.intraday_interval_seconds,
        intraday_retention_days=settings.intraday_retention_days,
        on_snapshot_published=on_snapshot_published,
        embedded_worker=settings.embedded_worker,
        worker_lease_seconds=settings.worker_lease_seconds,
        worker_poll_seconds=settings.worker_poll_seconds,
        analysis_stage=analysis.stage(),
        valuation_assumptions=valuation_assumptions,
    )
    scheduler = NightlyScheduler(
        jobs,
        enabled=automation_preferences.research_enabled,
        timezone=settings.nightly_timezone,
        local_times=settings.full_refresh_times,
        reconciliation_local_time=settings.daily_reconciliation_time,
    )
    intraday_scheduler = IntradayScheduler(
        jobs,
        enabled=automation_preferences.live_enabled,
        timezone=settings.intraday_timezone,
        interval_seconds=settings.intraday_interval_seconds,
        window_start=settings.intraday_window_start,
        window_end=settings.intraday_window_end,
        weekdays=settings.intraday_weekdays,
        scope="live",
        trigger="live",
        legacy_triggers=("intraday",),
    )
    performance_scheduler = IntradayScheduler(
        jobs,
        enabled=automation_preferences.performance_enabled,
        timezone=settings.intraday_timezone,
        interval_seconds=settings.performance_interval_seconds,
        window_start="00:00",
        window_end="00:00",
        weekdays=(1, 2, 3, 4, 5, 6, 7),
        scope="performance",
        trigger="performance",
        performance=True,
    )
    alert_monitor = AlertMonitor(
        store,
        research,
        live_alerts,
        enabled=settings.alert_monitor_enabled,
        held_interval_seconds=settings.alert_held_interval_seconds,
        watchlist_interval_seconds=settings.alert_watchlist_interval_seconds,
    )

    @asynccontextmanager
    async def lifespan(lifespan_app: FastAPI) -> AsyncIterator[None]:
        try:
            manifest = store.ensure_bootstrap()
            try:
                analysis.latest(
                    lens="daily_cio_brief",
                    snapshot_run_id=manifest.run_id,
                )
            except FileNotFoundError:
                try:
                    analysis.submit(
                        snapshot_run_id=manifest.run_id,
                        trigger="snapshot",
                    )
                except ProviderRuntimeError as exc:
                    logger.warning(
                        "initial analysis deferred until a provider is configured",
                        extra={"provider_error_code": exc.code},
                    )
            scheduler.start()
            intraday_scheduler.start()
            performance_scheduler.start()
            alert_monitor.start()
            threading.Thread(
                target=prewarm_research,
                name="trading-max-research-prewarm",
                daemon=True,
            ).start()
            logger.info(
                "service started",
                extra={
                    "snapshot_run_id": manifest.run_id,
                    "llm_provider": settings.llm_provider,
                    "nightly_enabled": scheduler.enabled,
                    "intraday_enabled": intraday_scheduler.enabled,
                    "performance_enabled": performance_scheduler.enabled,
                },
            )
        except Exception as exc:
            bootstrap_error = f"{type(exc).__name__}: {exc}"
            lifespan_app.state.bootstrap_error = bootstrap_error
            logger.exception(
                "bootstrap failed",
                extra={"error": bootstrap_error},
            )
        yield
        logger.info("service stopping")
        scheduler.close()
        intraday_scheduler.close()
        performance_scheduler.close()
        alert_monitor.close()
        jobs.close()
        analysis.close()
        preferences.close()

    app = FastAPI(
        title="Trading Max Portfolio API",
        version=trading_max_version,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.settings_repository = preferences
    app.state.credential_store = credentials
    app.state.jobs = jobs
    app.state.watchlist = watchlist
    app.state.scheduler = scheduler
    app.state.intraday_scheduler = intraday_scheduler
    app.state.performance_scheduler = performance_scheduler
    app.state.cfd_imports = cfd_imports
    app.state.analysis = analysis
    app.state.alert_monitor = alert_monitor
    app.state.research = research
    app.state.security_search = security_search
    app.state.valuation_assumptions = valuation_assumptions
    app.state.validation_secret = validation_secret
    app.state.cached_dashboard = cached_dashboard
    app.state.cached_research = cached_research
    app.state.cached_research_shell = cached_research_shell
    app.state.cached_research_lens = cached_research_lens
    app.state.bootstrap_error = None
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Trading-Max-Filename"],
    )

    _install_request_guards(app, settings, logger)
    app.include_router(system_router)
    app.include_router(settings_router)
    app.include_router(imports_router)
    app.include_router(analysis_router)
    app.include_router(operations_router)
    app.include_router(research_router)
    return app


def _install_request_guards(
    app: FastAPI,
    settings: Settings,
    logger: logging.Logger,
) -> None:
    write_methods = frozenset({"POST", "PUT", "PATCH", "DELETE"})
    max_body_bytes = MAX_CFD_IMPORT_BYTES
    cfd_import_path = "/v1/imports/trading212/cfd"
    rate_limit_window_seconds = 60.0
    rate_limit_max_requests = 30
    rate_limit_state: dict[tuple[str, str], tuple[float, int]] = {}
    rate_limit_lock = threading.Lock()

    def production_request_guard(request: Request) -> JSONResponse | None:
        environment = (
            os.environ.get(
                "TRADING_MAX_ENV",
                "development",
            )
            .strip()
            .lower()
        )
        if environment != "production":
            return None
        host = request.headers.get("host", "").split(":", 1)[0].strip("[]").lower()
        try:
            host_is_loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            host_is_loopback = host == "localhost"
        if not host_is_loopback:
            return JSONResponse(
                status_code=400,
                content={
                    "code": "loopback_host_required",
                    "message": ("production no-login mode only accepts loopback API requests"),
                },
            )

        origin = request.headers.get("origin")
        if origin and origin not in settings.allowed_origins:
            return JSONResponse(
                status_code=403,
                content={
                    "code": "origin_not_allowed",
                    "message": "request origin is not allowed for this deployment",
                },
            )
        fetch_site = request.headers.get("sec-fetch-site")
        if fetch_site and fetch_site not in {
            "same-origin",
            "same-site",
            "none",
        }:
            return JSONResponse(
                status_code=403,
                content={
                    "code": "fetch_metadata_rejected",
                    "message": "cross-site write requests are not accepted",
                },
            )
        if request.method not in write_methods:
            return None

        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_body_bytes:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "code": "request_body_too_large",
                            "message": "request body exceeds the 1 MiB limit",
                        },
                    )
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={
                        "code": "invalid_content_length",
                        "message": "invalid request content length",
                    },
                )
        if (
            request.url.path == "/v1/profile"
            or request.url.path.startswith("/v1/settings/integrations")
            or request.url.path == cfd_import_path
        ):
            client_host = request.client.host if request.client else "unknown"
            key = (client_host, request.url.path)
            now = time.monotonic()
            with rate_limit_lock:
                window_started, count = rate_limit_state.get(key, (now, 0))
                if now - window_started >= rate_limit_window_seconds:
                    window_started, count = now, 0
                if count >= rate_limit_max_requests:
                    return JSONResponse(
                        status_code=429,
                        headers={"Retry-After": "60"},
                        content={
                            "code": "settings_rate_limited",
                            "message": "too many Settings writes; retry later",
                        },
                    )
                rate_limit_state[key] = (window_started, count + 1)
        if request.method != "DELETE" and request.headers.get("content-length", "0") != "0":
            content_type = (
                request.headers.get(
                    "content-type",
                    "",
                )
                .split(";", 1)[0]
                .strip()
                .lower()
            )
            cfd_csv_upload = request.url.path == cfd_import_path and content_type in {
                "text/csv",
                "application/csv",
                "application/vnd.ms-excel",
            }
            if content_type != "application/json" and not cfd_csv_upload:
                return JSONResponse(
                    status_code=415,
                    content={
                        "code": "json_body_required",
                        "message": "write requests must use application/json",
                    },
                )
        return None

    @app.middleware("http")
    async def request_guard(request: Request, call_next):
        rejected = production_request_guard(request)
        if rejected is not None:
            return rejected
        return await call_next(request)

    @app.middleware("http")
    async def request_logging(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request failed",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round(
                        (time.perf_counter() - started) * 1000,
                        2,
                    ),
                },
            )
            raise
        duration_ms = round(
            (time.perf_counter() - started) * 1000,
            2,
        )
        level = logging.DEBUG if request.url.path == "/health" else logging.INFO
        if response.status_code >= 500:
            level = logging.ERROR
        elif response.status_code >= 400:
            level = logging.WARNING
        logger.log(
            level,
            "request completed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        response.headers["x-request-id"] = request_id
        return response


app = create_app()
