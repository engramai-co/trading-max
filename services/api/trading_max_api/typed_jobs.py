"""Typed API job control plane.

This module is deliberately independent of the historical subprocess bridge.
The API only admits jobs into SQLite; the same stage registry is used by the
dedicated worker and by the explicitly opt-in embedded worker used in tests.
"""

from __future__ import annotations

import logging
import secrets
import threading
from collections.abc import Callable
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from trading_max.analytics import (
    AccountSnapshotMetrics,
    latest_snapshot_path,
    metrics_from_snapshot_file,
)
from trading_max.analytics.lookthrough import LookthroughService
from trading_max.application.stages import StageRegistry
from trading_max.application.taxonomy_stages import RawTaxonomyCatalogProvider
from trading_max.domain import JobRecord as DomainJobRecord
from trading_max.domain import JobStatus as DomainJobStatus
from trading_max.infrastructure import SqliteDatabase, SqliteJobQueue, StoredSnapshot
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityDescriptor,
    canonical_security_type,
)
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.market import MarketResearchService
from trading_max.worker import DurableWorker

from .artifacts import ArtifactStore
from .job_errors import JobConflict
from .models import (
    GicsClassification,
    JobRecord,
    JobScope,
    JobStageRecord,
    JobStatus,
    JobTrigger,
    SecuritySearchResult,
)
from .watchlist import WatchlistStore, magnificent_seven_securities

LOGGER = logging.getLogger(__name__)

StagePlan = list[tuple[str, str]]
StageSpecs = list[tuple[str, str, str]]


def _structural_number(value: object) -> str:
    try:
        number = Decimal(str(value or 0))
    except InvalidOperation:
        return str(value)
    return format(number.normalize(), "f")


def _structural_projection(payload: dict[str, Any]) -> dict[str, Any] | None:
    accounts = payload.get("accounts")
    if not isinstance(accounts, dict):
        return None
    projection: dict[str, Any] = {}
    for code, account in sorted(accounts.items()):
        if not isinstance(account, dict):
            return None
        positions = account.get("positions")
        if not isinstance(positions, list):
            return None
        normalized_positions = []
        for position in positions:
            if not isinstance(position, dict):
                return None
            normalized_positions.append(
                (
                    str(position.get("isin") or ""),
                    str(position.get("ticker") or "").upper(),
                    _structural_number(position.get("quantity")),
                    _structural_number(position.get("total_cost_gbp")),
                )
            )
        projection[str(code)] = {
            "cash_gbp": _structural_number(account.get("cash_gbp")),
            "positions": sorted(normalized_positions),
        }
    return projection


def performance_refresh_needed(store: ArtifactStore) -> bool:
    """Compare live and canonical accounts using only structural fields."""

    manifest = store.latest_manifest()
    if manifest is None:
        return False
    try:
        live = store.read_json(manifest.run_id, "account/intraday/broker_values.json")
        canonical = store.read_json(manifest.run_id, "account/broker_snapshot_metrics.json")
    except (FileNotFoundError, TypeError, ValueError):
        return False
    live_projection = _structural_projection(live)
    canonical_projection = _structural_projection(canonical)
    return (
        live_projection is not None
        and canonical_projection is not None
        and live_projection != canonical_projection
    )


def _migration_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "backend" / "migrations"


def _api_record(record: DomainJobRecord) -> JobRecord:
    trigger: JobTrigger = (
        record.trigger
        if record.trigger
        in {
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
        }
        else "on_demand"
    )
    status = JobStatus(record.status.value)
    stage_codes = [stage.return_code for stage in record.stages if stage.return_code is not None]
    return JobRecord(
        schema_version=2,
        job_id=record.job_id,
        scope=record.scope,
        skip_sync=record.skip_sync,
        trigger=trigger,
        scheduled_for=record.scheduled_for,
        status=status,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        snapshot_run_id=record.snapshot_run_id,
        return_code=(
            stage_codes[-1] if stage_codes else (0 if status == JobStatus.SUCCEEDED else None)
        ),
        error=record.error_message,
        tickers=record.tickers,
        stages=[
            JobStageRecord(
                name=stage.name,
                label=stage.label or stage.name,
                idempotency_key=stage.idempotency_key,
                status=stage.status.value,
                started_at=stage.started_at,
                finished_at=stage.finished_at,
                return_code=stage.return_code,
                error=stage.error_message,
            )
            for stage in record.stages
        ],
    )


def stage_plan(
    scope: JobScope,
    *,
    skip_sync: bool,
    trigger: JobTrigger = "on_demand",
) -> StagePlan:
    """Declare ordered stage names and operator-facing labels.

    Versions intentionally do not live here. They belong to the executable
    stage registry and are materialized immediately before queue admission.
    """

    if scope == "cfd":
        return [
            ("accounts.cfd", "Build imported CFD ledger and analysis"),
            ("snapshot.publish", "Publish immutable snapshot"),
        ]
    if scope in {"intraday", "live"}:
        if skip_sync:
            raise ValueError("intraday refreshes cannot skip broker sync")
        return [
            ("broker.sync", "Sync broker values"),
            ("accounts.snapshot", "Normalize accounts"),
            ("accounts.intraday_nav", "Append intraday NAV anchor"),
            ("snapshot.publish", "Publish immutable snapshot"),
        ]
    if scope == "performance":
        if not skip_sync:
            raise ValueError("performance refreshes must reuse the latest live broker snapshot")
        return [
            ("accounts.snapshot", "Normalize accounts"),
            ("accounts.nav", "Update account NAV"),
            ("accounts.performance", "Calculate account performance"),
            ("snapshot.publish", "Publish immutable snapshot"),
        ]
    stages: StagePlan = []
    if scope in {"all", "accounts"}:
        if not skip_sync:
            stages.append(("broker.sync", "Sync broker data"))
        stages.extend(
            [
                ("accounts.snapshot", "Normalize accounts"),
                (
                    "reference.security_master",
                    "Resolve securities and classify market profiles",
                ),
                ("portfolio.lookthrough", "Calculate portfolio look-through"),
                ("accounts.diluted_cost", "Calculate diluted cost"),
                ("accounts.policy", "Analyze account policy"),
                ("accounts.capital_recovery", "Audit capital recovery"),
                ("accounts.nav", "Update account NAV"),
                ("accounts.cfd", "Build imported CFD ledger and analysis"),
                ("accounts.performance", "Calculate account performance"),
                ("accounts.review", "Build deterministic account reviews"),
            ]
        )
    if scope == "research" and trigger == "research":
        # Scheduled research also refreshes position-dependent look-through,
        # but deliberately reuses the latest lightweight broker snapshot.
        stages.extend(
            [
                ("accounts.snapshot", "Normalize accounts for look-through"),
                (
                    "reference.security_master",
                    "Resolve securities and classify market profiles",
                ),
                ("portfolio.lookthrough", "Calculate portfolio look-through"),
            ]
        )
    if scope in {"all", "research"}:
        stages.extend(
            [
                ("market.snapshot", "Fetch market data"),
                ("research.taxonomy", "Normalize research taxonomy"),
                ("research.technical", "Update technical research"),
                ("research.options", "Update options research"),
                ("research.adr", "Update ADR research"),
                ("research.fundamentals", "Update fundamentals research"),
                ("research.financials", "Update financial statements"),
                ("research.analyst", "Update analyst consensus research"),
                ("research.valuation", "Update valuation research"),
                ("research.earnings", "Update earnings research"),
            ]
        )
    stages.append(("snapshot.publish", "Publish immutable snapshot"))
    return stages


def stage_specs(
    registry: StageRegistry,
    scope: JobScope,
    *,
    skip_sync: bool,
    trigger: JobTrigger = "on_demand",
) -> StageSpecs:
    """Bind an admitted plan to the exact executable stage versions."""

    plan = stage_plan(scope, skip_sync=skip_sync, trigger=trigger)
    registry.validate_order([name for name, _label in plan])
    return [(name, registry.get(name).version, label) for name, label in plan]


def reconcile_watchlist_after_job(
    status: DomainJobStatus,
    record: DomainJobRecord,
    *,
    store: ArtifactStore,
    watchlist: WatchlistStore,
) -> None:
    """Reconcile research readiness after a terminal research-bearing job."""

    if record.scope not in {"all", "research"} or not record.tickers:
        return
    if status != DomainJobStatus.SUCCEEDED:
        manifest = store.latest_manifest()
        if manifest is not None:
            # A failed refresh must leave previously published research usable.
            # New tickers absent from that snapshot still reconcile to ``failed``.
            watchlist.reconcile(manifest, store, record.tickers)
        else:
            watchlist.set_status(
                record.tickers,
                "failed",
                last_run_id=record.snapshot_run_id,
                error=record.error_message or "Research refresh did not complete",
            )
        return
    manifest = store.latest_manifest()
    if manifest is not None:
        watchlist.reconcile(manifest, store, record.tickers)


class TypedJobManager:
    """SQLite admission/status API for the production typed worker."""

    def __init__(
        self,
        store: ArtifactStore,
        watchlist: WatchlistStore,
        *,
        intraday_interval_seconds: int = 600,
        intraday_retention_days: int = 40,
        on_snapshot_published: Callable[[StoredSnapshot, str], None] | None = None,
        analysis_stage: Any | None = None,
        embedded_worker: bool = False,
        worker_lease_seconds: int = 300,
        worker_poll_seconds: float = 1.0,
        market_service: MarketResearchService | None = None,
        research_service: YFinanceResearchService | None = None,
        lookthrough_service: LookthroughService | None = None,
        taxonomy_provider: RawTaxonomyCatalogProvider | None = None,
        valuation_assumptions=None,
    ) -> None:
        from trading_max.application import TypedWorkerRuntime

        self.store = store
        self.watchlist = watchlist
        self.database = SqliteDatabase(
            store.data_root / "trading_max.db",
            migrations_dir=_migration_dir(),
        )
        self.queue = SqliteJobQueue(self.database)
        extras = (analysis_stage,) if analysis_stage is not None else ()
        self.runtime = TypedWorkerRuntime(
            store.data_root,
            intraday_interval_seconds=intraday_interval_seconds,
            intraday_retention_days=intraday_retention_days,
            market_service=market_service,
            research_service=research_service,
            lookthrough_service=lookthrough_service,
            taxonomy_provider=taxonomy_provider,
            valuation_assumptions=valuation_assumptions,
            on_snapshot_published=on_snapshot_published,
            extra_stages=extras,
        )
        # Queue admission and execution share this exact registry. Stage
        # versions therefore have one process-local source of truth.
        self.registry = self.runtime.registry()
        self.worker_poll_seconds = worker_poll_seconds
        self._stop = threading.Event()
        self._worker_thread: threading.Thread | None = None
        self._worker: DurableWorker | None = None
        if embedded_worker:
            self._worker = self._build_worker(
                worker_id="embedded-api-worker",
                lease_seconds=worker_lease_seconds,
            )
            self._worker_thread = threading.Thread(
                target=self._run_embedded_worker,
                name="trading_max-embedded-worker",
                daemon=True,
            )
            self._worker_thread.start()

    def _stage_specs(
        self,
        scope: JobScope,
        *,
        skip_sync: bool,
        trigger: JobTrigger = "on_demand",
    ) -> StageSpecs:
        return stage_specs(
            self.registry,
            scope,
            skip_sync=skip_sync,
            trigger=trigger,
        )

    def _build_worker(self, *, worker_id: str, lease_seconds: int) -> DurableWorker:
        def finished(status: DomainJobStatus, claimed) -> None:
            if status not in {
                DomainJobStatus.SUCCEEDED,
                DomainJobStatus.FAILED,
                DomainJobStatus.INTERRUPTED,
            }:
                return
            try:
                reconcile_watchlist_after_job(
                    status,
                    claimed.record,
                    store=self.store,
                    watchlist=self.watchlist,
                )
            except Exception:
                LOGGER.exception("failed to reconcile watchlist research status")
            if (
                status == DomainJobStatus.SUCCEEDED
                and claimed.record.trigger in {"intraday", "live"}
                and self.performance_refresh_needed()
            ):
                already_pending = any(
                    record.scope == "accounts"
                    and record.trigger == "performance"
                    and not record.skip_sync
                    and record.status in {DomainJobStatus.QUEUED, DomainJobStatus.RUNNING}
                    for record in self.queue.list(limit=5_000)
                )
                if not already_pending:
                    job_id = secrets.token_hex(16)
                    self.queue.enqueue(
                        "accounts",
                        skip_sync=False,
                        trigger="performance",
                        stages=self._stage_specs(
                            "accounts",
                            skip_sync=False,
                            trigger="performance",
                        ),
                        log_path=str(self.store.logs_root / "jobs" / f"{job_id}.log"),
                        job_id=job_id,
                    )
            follow_up = self.queue.consume_follow_up(claimed.record.job_id)
            if follow_up is not None and status == DomainJobStatus.SUCCEEDED:
                try:
                    self.submit(
                        "research",
                        skip_sync=True,
                        tickers=follow_up,
                        trigger="on_demand",
                    )
                except JobConflict:
                    LOGGER.warning("coalesced research follow-up was not admitted")

        return DurableWorker(
            self.queue,
            self.registry,
            worker_id=worker_id,
            lease_seconds=lease_seconds,
            on_job_finished=finished,
        )

    def _run_embedded_worker(self) -> None:
        if self._worker is None:
            raise RuntimeError("embedded worker is not configured")
        while not self._stop.is_set():
            try:
                did_work = self._worker.run_once()
            except Exception:
                LOGGER.exception("embedded typed worker iteration failed")
                did_work = False
            self._stop.wait(0.05 if did_work else self.worker_poll_seconds)

    @property
    def active_job_id(self) -> str | None:
        return self.queue.active_job_id()

    def queue_health(self) -> dict[str, object]:
        return self.queue.queue_health()

    def performance_refresh_needed(self) -> bool:
        """Return whether verified position-dependent analytics are structurally stale."""
        return performance_refresh_needed(self.store)

    def worker_health(self) -> dict[str, object] | None:
        return self.queue.worker_health()

    def _latest_account_metrics(self, profile: str) -> AccountSnapshotMetrics | None:
        """Load the latest broker position snapshot across supported layouts."""

        for root in (
            self.store.data_root / "trading212",
            self.store.data_root / "raw" / "trading212",
            self.store.data_root,
        ):
            try:
                path = latest_snapshot_path(profile, data_root=root)
            except FileNotFoundError:
                continue
            return metrics_from_snapshot_file(profile, path)
        return None

    def _held_equity_watchlist(self) -> list[SecuritySearchResult]:
        """Resolve current direct stock holdings into a research universe."""

        security_master = CatalogSecurityMaster.from_state_root(self.store.data_root)
        candidates: dict[str, SecuritySearchResult] = {}
        for profile in ("invest", "isa"):
            metrics = self._latest_account_metrics(profile)
            if metrics is None:
                continue
            for position in metrics.positions:
                resolved = security_master.resolve(
                    SecurityDescriptor(
                        ticker=position.ticker,
                        name=position.name,
                        isin=position.isin,
                    )
                )
                provider_info: dict[str, Any] = {}
                security_type = resolved.security_type
                if security_type == "UNKNOWN":
                    try:
                        provider_info = dict(
                            self.runtime.research_service.info_loader(position.ticker)
                        )
                    except Exception:
                        LOGGER.warning(
                            "could not classify first-run holding %s",
                            position.ticker,
                            exc_info=True,
                        )
                    security_type = canonical_security_type(
                        quote_type=str(provider_info.get("quoteType") or ""),
                    )
                if security_type != "EQUITY":
                    continue
                ticker = (
                    resolved.canonical_ticker
                    if resolved.method != "unresolved"
                    else str(provider_info.get("symbol") or position.ticker)
                )
                entity_key = (
                    resolved.entity_id
                    if resolved.method != "unresolved"
                    else (f"isin:{position.isin}" if position.isin else f"ticker:{ticker}")
                )
                if entity_key in candidates:
                    continue
                gics = (
                    GicsClassification.model_validate(
                        resolved.gics.model_dump(mode="json", by_alias=True)
                    )
                    if resolved.gics is not None
                    else None
                )
                candidates[entity_key] = SecuritySearchResult(
                    ticker=ticker,
                    name=(
                        resolved.entity_name
                        if resolved.method != "unresolved"
                        else str(
                            provider_info.get("longName")
                            or provider_info.get("shortName")
                            or position.name
                            or ticker
                        )
                    ),
                    exchange=str(
                        provider_info.get("exchange")
                        or provider_info.get("fullExchangeName")
                        or "US"
                    ),
                    bloomberg_ticker=f"{ticker} US Equity",
                    figi="",
                    entity_id=entity_key,
                    canonical_ticker=ticker,
                    gics=gics,
                    resolution_method=resolved.method,
                    resolution_confidence=resolved.confidence,
                    identity_source=(
                        resolved.source if resolved.method != "unresolved" else "yahoo-finance"
                    ),
                    security_type=security_type,
                )
        return list(candidates.values())

    def _bootstrap_watchlist(self) -> list[str]:
        """Seed direct holdings, or Mag 7 when the account has no stocks."""

        existing = self.watchlist.tickers()
        if existing:
            return existing
        held_equities = self._held_equity_watchlist()
        securities = held_equities or magnificent_seven_securities()
        seeded = self.watchlist.seed_if_empty(securities)
        tickers = [item.ticker for item in seeded]
        if tickers:
            LOGGER.info(
                "seeded first-run watchlist from %s: %s",
                "direct holdings" if held_equities else "Mag 7 fallback",
                ", ".join(tickers),
            )
            return tickers
        return self.watchlist.tickers()

    def submit(
        self,
        scope: JobScope,
        *,
        skip_sync: bool,
        tickers: list[str] | None = None,
        trigger: JobTrigger = "on_demand",
        scheduled_for: datetime | None = None,
    ) -> JobRecord:
        if scope == "performance":
            skip_sync = True
        active_records = [
            record
            for record in self.queue.list(limit=5_000)
            if record.status in {DomainJobStatus.QUEUED, DomainJobStatus.RUNNING}
        ]
        active_full = next(
            (
                record
                for record in active_records
                if record.trigger not in {"intraday", "live", "system"}
            ),
            None,
        )
        active_intraday = next(
            (record for record in active_records if record.trigger in {"intraday", "live"}),
            None,
        )
        if scope in {"intraday", "live"}:
            blocking_full = next(
                (
                    record
                    for record in active_records
                    if record.trigger in {"on_demand", "nightly", "reconciliation"}
                ),
                None,
            )
            if blocking_full is not None:
                raise JobConflict(f"full refresh {blocking_full.job_id} has priority over intraday")
            if active_intraday is not None:
                raise JobConflict(f"intraday refresh {active_intraday.job_id} is already active")
            trigger = "live" if scope == "live" else "intraday"
        elif active_full is not None:
            raise JobConflict(f"job {active_full.job_id} is already queued or running")
        if scope in {"accounts", "performance", "intraday", "live", "cfd"}:
            research_tickers: list[str] = []
        elif tickers:
            research_tickers = list(dict.fromkeys(tickers))
        else:
            research_tickers = list(dict.fromkeys(self._bootstrap_watchlist()))
        job_id = secrets.token_hex(16)
        record = self.queue.enqueue(
            scope,
            trigger=trigger,
            skip_sync=skip_sync,
            tickers=research_tickers,
            stages=self._stage_specs(scope, skip_sync=skip_sync, trigger=trigger),
            scheduled_for=scheduled_for,
            log_path=str(self.store.logs_root / "jobs" / f"{job_id}.log"),
            job_id=job_id,
        )
        return _api_record(record)

    def request_research_follow_up(self, tickers: list[str]) -> None:
        active = self.active_job_id
        if active is not None:
            self.queue.request_research_follow_up(active, tickers=tickers)

    def cancel(self, job_id: str, *, reason: str = "cancelled by operator") -> JobRecord:
        try:
            return _api_record(self.queue.cancel(job_id, reason=reason))
        except KeyError as exc:
            raise FileNotFoundError(str(exc)) from exc

    def get(self, job_id: str) -> JobRecord:
        try:
            return _api_record(self.queue.get(job_id))
        except KeyError as exc:
            raise FileNotFoundError(str(exc)) from exc

    def list(self, limit: int = 20) -> list[JobRecord]:
        # LLM synthesis uses the same SQLite queue with a private ``system``
        # trigger.  It is an internal additive stage, not a portfolio refresh
        # and must not block or masquerade as the latest full refresh in the
        # public scheduler state.
        visible = self.queue.list(limit=max(1, limit), include_system=False)
        return [_api_record(record) for record in visible]

    def latest_refreshes(self) -> tuple[JobRecord | None, JobRecord | None]:
        full, intraday = self.queue.latest_refreshes()
        return (
            _api_record(full) if full is not None else None,
            _api_record(intraday) if intraday is not None else None,
        )

    def trigger_summary(self, trigger: str) -> tuple[JobRecord | None, dict[str, int]]:
        if trigger not in {
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
            "system",
        }:
            raise ValueError(f"invalid job trigger: {trigger}")
        latest, counts = self.queue.trigger_summary(trigger)
        return (_api_record(latest) if latest is not None else None, counts)

    def log(self, job_id: str, *, max_bytes: int = 200_000) -> str:
        record = self.queue.get(job_id)
        path = (
            Path(record.log_path)
            if record.log_path
            else (self.store.logs_root / "jobs" / f"{job_id}.log")
        )
        if not path.is_file():
            return ""
        with path.open("rb") as handle:
            size = path.stat().st_size
            if size > max_bytes:
                handle.seek(-max_bytes, 2)
            return handle.read().decode("utf-8", errors="replace")

    def close(self) -> None:
        self._stop.set()
        if self._worker_thread is not None:
            self._worker_thread.join(timeout=5)
        if self._worker is not None:
            self._worker.close()
        self.database.close()


__all__ = [
    "TypedJobManager",
    "performance_refresh_needed",
    "reconcile_watchlist_after_job",
    "stage_specs",
]
