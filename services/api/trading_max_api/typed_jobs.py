"""Typed API job control plane.

This module is deliberately independent of the historical subprocess bridge.
The API only admits jobs into SQLite; the same stage registry is used by the
dedicated worker and by the opt-in embedded worker used by local workspaces.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from functools import partial
from pathlib import Path
from typing import Any

from trading_max.analytics import (
    AccountSnapshotMetrics,
    latest_snapshot_path,
    metrics_from_snapshot_file,
)
from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY, ETFPortfolio
from trading_max.analytics.intraday import DEFAULT_INTRADAY_RETENTION_DAYS
from trading_max.analytics.lookthrough import LookthroughService
from trading_max.application.account_selection import ACCOUNT_PROFILES
from trading_max.application.broker_stages import broker_snapshot_key
from trading_max.application.stages import StageRegistry
from trading_max.application.taxonomy_stages import RawTaxonomyCatalogProvider
from trading_max.domain import JobRecord as DomainJobRecord
from trading_max.domain import JobStatus as DomainJobStatus
from trading_max.infrastructure import ClaimedJob, SqliteDatabase, SqliteJobQueue, StoredSnapshot
from trading_max.infrastructure.job_queue import AccountEvidence, QueueConflict
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityDescriptor,
    SecurityMasterCatalog,
    canonical_security_type,
)
from trading_max.research.estimate_history import SCHEDULED_RESEARCH_TRIGGERS, EstimateHistory
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.held_funds import (
    BROKER_SNAPSHOT_KEY,
    LOOKTHROUGH_KEY,
    SECURITY_MASTER_KEY,
    held_fund_positions,
)
from trading_max.research.listing import LONDON, broker_listing
from trading_max.research.market import MarketResearchService
from trading_max.worker import (
    ANALYSIS_LANE_TRIGGERS,
    LIVE_LANE_TRIGGERS,
    MAIN_LANE_TRIGGERS,
    DurableWorker,
)

from .artifacts import ArtifactStore
from .job_errors import JobConflict
from .models import (
    GicsClassification,
    JobRecord,
    JobScope,
    JobStageRecord,
    JobStatus,
    JobTrigger,
    RefreshAttention,
    RefreshFailure,
    SecuritySearchResult,
)
from .projections.broker import broker_observed_at, overlay_live_broker_snapshot
from .watchlist import TICKER_PATTERN, WatchlistStore, magnificent_seven_securities

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


def performance_refresh_needed(
    store: ArtifactStore, *, verified_accounts: dict[str, dict] | None = None
) -> bool:
    """Compare live and canonical accounts using only structural fields."""

    manifest = store.latest_manifest()
    if manifest is None:
        return False
    try:
        live = (
            store.read_json(manifest.run_id, "account/intraday/broker_values.json")
            if verified_accounts is None
            else {"accounts": verified_accounts}
        )
        canonical = store.read_json(manifest.run_id, "account/broker_snapshot_metrics.json")
    except (FileNotFoundError, TypeError, ValueError):
        return False
    live_projection = _structural_projection(live)
    canonical_projection = _structural_projection(canonical)
    if live_projection is None or canonical_projection is None:
        return False
    if verified_accounts is None and live_projection.keys() != canonical_projection.keys():
        return True
    freshest = {}
    for code, account in live["accounts"].items():
        reference = canonical["accounts"].get(code)
        live_at = broker_observed_at(account)
        canonical_at = broker_observed_at(reference) if reference is not None else None
        if (
            verified_accounts is None
            and live_at is not None
            and canonical_at is not None
            and live_at < canonical_at
        ):
            freshest[code] = reference
            continue
        if live_projection[code] != canonical_projection.get(code):
            return True
        freshest[code] = account
    # Research can refresh the canonical account summary without reconciling
    # its ledger. Keep a changed account pending against the last verified
    # cash-flow state even after those two summaries have become identical.
    from trading_max.analytics.cash_flow_history import account_state_digest

    for code in ("A", "B"):
        account = freshest.get(code)
        if account is None:
            continue
        try:
            flows = store.read_json(manifest.run_id, f"account/nav/cash_flows_{code.lower()}.json")
        except (FileNotFoundError, TypeError, ValueError):
            continue
        if (
            isinstance(flows, dict)
            and flows.get("verified") is True
            and flows.get("account_state_digest")
            and flows["account_state_digest"] != account_state_digest(account)
        ):
            return True
    return False


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
        attempts=record.attempts,
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
            ("accounts.day_attribution", "Attribute today's position changes"),
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
                ("accounts.intraday_nav", "Reconstruct intraday valuation history"),
                ("accounts.day_attribution", "Attribute today's position changes"),
                ("accounts.cfd", "Build imported CFD ledger and analysis"),
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
                ("research.fund_prices", "Update fund price history"),
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
    if scope in {"all", "accounts"}:
        stages.extend(
            [
                ("accounts.performance", "Calculate account performance"),
                ("accounts.review", "Build deterministic account reviews"),
                ("accounts.decisions", "Score buys and sells against what followed"),
            ]
        )
    if scope in {"all", "research"} and trigger in SCHEDULED_RESEARCH_TRIGGERS:
        stages.extend(
            [
                ("research.security_news", "Refresh security news"),
                ("research.macro_calendar", "Refresh official macro calendars"),
            ]
        )
    stages.append(("research.etf_depth", "Update ETF research evidence"))
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


def _verified_account_evidence(
    store: ArtifactStore, job: DomainJobRecord, artifact_ids: tuple[str, ...]
) -> dict[str, AccountEvidence]:
    live = job.trigger in LIVE_LANE_TRIGGERS
    if not live and (job.scope not in {"all", "accounts"} or job.skip_sync):
        return {}
    artifacts = store.immutable_artifacts
    by_key = {ref.key: ref for ref in map(artifacts.get_ref, artifact_ids)}
    evidence = {}
    if live:
        ref = by_key.get("account/intraday/broker_values.json")
        if ref is None:
            return {}
        accounts = artifacts.get_json(ref.artifact_id).payload["accounts"]
        for code, account in accounts.items():
            if account.get("positions_status") == "verified" and isinstance(
                account.get("positions"), list
            ):
                observed_at = broker_observed_at(account)
                if observed_at is not None:
                    evidence[code] = AccountEvidence(observed_at, ref.artifact_id)
    else:
        for code, profile in ACCOUNT_PROFILES:
            ref = by_key.get(broker_snapshot_key(profile, intraday=False))
            if ref is not None and ref.quality.status == "verified":
                observed_at = broker_observed_at(artifacts.get_json(ref.artifact_id).payload)
                if observed_at is not None:
                    evidence[code] = AccountEvidence(observed_at, ref.artifact_id)
    return evidence


def process_account_check(
    queue: SqliteJobQueue, registry: StageRegistry, store: ArtifactStore
) -> None:
    """Recheck verified observations after any active reconciliation finishes."""
    checks = queue.pending_account_checks()
    if not checks or any(
        record.scope in {"all", "accounts"} and not record.skip_sync
        for record in queue.active_records()
    ):
        return
    changed = {}
    for code, evidence in checks.items():
        data = store.immutable_artifacts.get_json(evidence.artifact_id).payload
        if performance_refresh_needed(store, verified_accounts={code: data["accounts"][code]}):
            changed[code] = evidence
    if not changed:
        return
    try:
        queue.enqueue(
            "accounts",
            trigger="performance",
            skip_sync=False,
            stages=stage_specs(registry, "accounts", skip_sync=False, trigger="performance"),
            account_checks=changed,
        )
    except QueueConflict:
        # A newer verified result or a user-queued reconciliation won this race.
        return


class TypedJobManager:
    """SQLite admission/status API for the production typed worker."""

    def __init__(
        self,
        store: ArtifactStore,
        watchlist: WatchlistStore,
        *,
        intraday_interval_seconds: int = 600,
        intraday_retention_days: int = DEFAULT_INTRADAY_RETENTION_DAYS,
        on_snapshot_published: Callable[[StoredSnapshot, str], None] | None = None,
        analysis_stage: Any | None = None,
        embedded_worker: bool = False,
        worker_lease_seconds: int = 300,
        worker_poll_seconds: float = 1.0,
        market_service: MarketResearchService | None = None,
        assistant_enabled: Callable[[], bool] = lambda: False,
        research_service: YFinanceResearchService | None = None,
        lookthrough_service: LookthroughService | None = None,
        taxonomy_provider: RawTaxonomyCatalogProvider | None = None,
        valuation_assumptions=None,
        intraday_history_loader_factory=None,
        broker_profiles_loader=None,
    ) -> None:
        from trading_max.application import TypedWorkerRuntime

        self.store = store
        self.watchlist = watchlist
        self.database = SqliteDatabase(
            store.data_root / "trading_max.db",
            migrations_dir=_migration_dir(),
        )
        self.queue = SqliteJobQueue(self.database)
        self.estimate_history = EstimateHistory(self.database)
        self._stop = threading.Event()
        extras = (analysis_stage,) if analysis_stage is not None else ()
        self.runtime = TypedWorkerRuntime(
            store.data_root,
            intraday_interval_seconds=intraday_interval_seconds,
            intraday_retention_days=intraday_retention_days,
            market_service=market_service,
            assistant_enabled=assistant_enabled,
            research_service=research_service,
            lookthrough_service=lookthrough_service,
            taxonomy_provider=taxonomy_provider,
            valuation_assumptions=valuation_assumptions,
            intraday_history_loader_factory=intraday_history_loader_factory,
            broker_profiles_loader=broker_profiles_loader,
            stop_event=self._stop,
            on_snapshot_published=on_snapshot_published,
            extra_stages=extras,
            estimate_history=self.estimate_history,
        )
        # Queue admission and execution share this exact registry. Stage
        # versions therefore have one process-local source of truth.
        self.registry = self.runtime.registry()
        self._worker_lanes: list[tuple[threading.Thread, SqliteDatabase]] = []
        self._has_analysis_lane = analysis_stage is not None
        if embedded_worker:
            self.start_worker_lanes(
                worker_id="embedded-api-worker",
                lease_seconds=worker_lease_seconds,
                poll_seconds=worker_poll_seconds,
            )

    def start_worker_lanes(
        self, *, worker_id: str | None, lease_seconds: int, poll_seconds: float
    ) -> threading.Thread:
        """Start the same trigger-isolated worker lanes for desktop and dedicated use."""
        lanes = [("", MAIN_LANE_TRIGGERS), ("-live", LIVE_LANE_TRIGGERS)]
        if self._has_analysis_lane:
            lanes.append(("-analysis", ANALYSIS_LANE_TRIGGERS))
        for suffix, triggers in lanes:
            database = SqliteDatabase(
                self.database.path, migrations_dir=self.database.migrations_dir
            )
            queue = SqliteJobQueue(database)
            worker = self._build_worker(
                worker_id=f"{worker_id}{suffix}" if suffix else worker_id,
                lease_seconds=lease_seconds,
                queue=queue,
                allowed_triggers=triggers,
            )
            if not suffix:
                worker_id = worker.worker_id
            thread = threading.Thread(
                target=worker.run_loop,
                args=(self._stop, poll_seconds),
                kwargs={
                    "before_poll": partial(process_account_check, queue, self.registry, self.store)
                }
                if not suffix
                else {},
                name=worker.worker_id,
                daemon=True,
            )
            self._worker_lanes.append((thread, database))
        for thread, _ in self._worker_lanes:
            thread.start()
        return self._worker_lanes[0][0]

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

    def _build_worker(
        self,
        *,
        worker_id: str | None,
        lease_seconds: int,
        queue: SqliteJobQueue | None = None,
        allowed_triggers: tuple[str, ...] | None = None,
    ) -> DurableWorker:
        queue = queue if queue is not None else self.queue

        def finished(status: DomainJobStatus, claimed: ClaimedJob) -> None:
            if status not in {
                DomainJobStatus.SUCCEEDED,
                DomainJobStatus.FAILED,
                DomainJobStatus.INTERRUPTED,
            }:
                return
            try:
                reconcile_watchlist_after_job(
                    status, claimed.record, store=self.store, watchlist=self.watchlist
                )
            except Exception:
                LOGGER.exception("failed to reconcile watchlist research status")
            if status != DomainJobStatus.SUCCEEDED:
                return
            follow_up = queue.consume_follow_up(claimed.record.job_id)
            if follow_up is not None:
                try:
                    queue.enqueue(
                        "research",
                        trigger="on_demand",
                        skip_sync=True,
                        tickers=follow_up,
                        stages=self._stage_specs("research", skip_sync=True),
                    )
                except Exception:
                    LOGGER.exception("failed to enqueue coalesced research follow-up")

        return DurableWorker(
            queue,
            self.registry,
            worker_id=worker_id,
            lease_seconds=lease_seconds,
            on_job_finished=finished,
            stop_event=self._stop,
            allowed_triggers=allowed_triggers,
            account_evidence=partial(_verified_account_evidence, self.store),
        )

    @property
    def active_job_id(self) -> str | None:
        return self.queue.active_job_id()

    def queue_health(self) -> dict[str, object]:
        return self.queue.queue_health()

    def outcomes(self, since: datetime) -> dict[str, object]:
        return self.queue.outcomes(since)

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

    def _held_research_tickers(self) -> list[str]:
        """Use direct broker listings without changing the saved watchlist."""
        tickers: list[str] = []
        for profile in ("invest", "isa"):
            try:
                metrics = self._latest_account_metrics(profile)
            except (OSError, ValueError, RuntimeError):
                # An unavailable broker snapshot does not block watchlist research.
                LOGGER.warning("could not load %s holdings for scheduled research", profile)
                continue
            if metrics is None:
                continue
            for position in metrics.positions:
                listing = broker_listing(position.broker_ticker)
                if listing is not None:
                    market, symbol = listing.split(":", 1)
                    ticker = f"{symbol}.L" if market == LONDON else symbol
                else:
                    # Imported and preview positions can already contain the listing symbol.
                    ticker = position.ticker.strip().upper()
                if TICKER_PATTERN.fullmatch(ticker):
                    tickers.append(ticker)
        return tickers

    def _held_fund_tickers(self) -> list[str]:
        manifest = self.store.latest_manifest()

        def read(key):
            if manifest is not None:
                try:
                    return self.store.read_json(manifest.run_id, key)
                except FileNotFoundError:
                    pass
            return {}

        # Before the first publication the broker snapshots and reference
        # catalog can already identify known held funds.
        broker = overlay_live_broker_snapshot(
            read(BROKER_SNAPSHOT_KEY), read("account/intraday/broker_values.json")
        )
        if not broker:
            broker = {"accounts": {}}
            for profile in ("invest", "isa"):
                try:
                    metrics = self._latest_account_metrics(profile)
                except (OSError, ValueError, RuntimeError):
                    continue
                if metrics:
                    broker["accounts"][profile] = metrics.model_dump()
        raw_catalog = read(SECURITY_MASTER_KEY)
        catalog = (
            CatalogSecurityMaster(SecurityMasterCatalog.model_validate(raw_catalog))
            if raw_catalog
            else CatalogSecurityMaster.from_state_root(self.store.data_root)
        )
        funds = held_fund_positions(
            broker,
            read(LOOKTHROUGH_KEY),
            ETFPortfolio.model_validate(read(ETF_SUMMARY_KEY)).funds,
            catalog,
        )
        return [fund.ticker for fund in funds if TICKER_PATTERN.fullmatch(fund.ticker)]

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
        active_records = self.queue.active_records()
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
            research_tickers = [*self._bootstrap_watchlist(), *self._held_fund_tickers()]
            if trigger in SCHEDULED_RESEARCH_TRIGGERS:
                research_tickers = [*research_tickers, *self._held_research_tickers()]
            research_tickers = list(dict.fromkeys(research_tickers))
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

    def get(self, job_id: str, *, include_system: bool = True) -> JobRecord:
        try:
            record = self.queue.get(job_id)
            if not include_system and record.trigger == "system":
                raise FileNotFoundError("Internal job")
            return _api_record(record)
        except KeyError as exc:
            raise FileNotFoundError(str(exc)) from exc

    def list(self, limit: int = 20) -> list[JobRecord]:
        # LLM synthesis uses the same SQLite queue with a private ``system``
        # trigger.  It is an internal additive stage, not a portfolio refresh
        # and must not block or masquerade as the latest full refresh in the
        # public scheduler state.
        visible = self.queue.list(limit=max(1, limit), include_system=False)
        return [_api_record(record) for record in visible]

    def latest_terminal_jobs(self) -> list[JobRecord]:
        return [_api_record(record) for record in self.queue.latest_terminal_jobs()]

    def latest_refreshes(self) -> tuple[JobRecord | None, JobRecord | None]:
        full, intraday = self.queue.latest_refreshes()
        return (
            _api_record(full) if full is not None else None,
            _api_record(intraday) if intraday is not None else None,
        )

    def refresh_attention(self, *, now: datetime | None = None) -> RefreshAttention:
        checked_at = now or datetime.now(UTC)
        # Ignore an isolated failure. Repeated failures become actionable after
        # three attempts, or two attempts with the outage lasting half an hour.
        return RefreshAttention(
            checked_at=checked_at,
            issues=[
                RefreshFailure(
                    scope=streak.scope,
                    consecutive_failures=streak.consecutive_failures,
                    failing_since=streak.failing_since,
                )
                for streak in self.queue.refresh_failure_streaks()
                if streak.consecutive_failures >= 3
                or (
                    streak.consecutive_failures >= 2
                    and checked_at - streak.failing_since >= timedelta(minutes=30)
                )
            ],
        )

    def latest_for_triggers(self, triggers: tuple[str, ...]) -> JobRecord | None:
        record = self.queue.latest_for_triggers(triggers)
        return _api_record(record) if record is not None else None

    def scheduled_attempt(
        self, triggers: tuple[str, ...], scheduled_for: datetime
    ) -> JobRecord | None:
        record = self.queue.scheduled_attempt(triggers, scheduled_for)
        return _api_record(record) if record is not None else None

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
        try:
            record = self.queue.get(job_id)
        except KeyError as exc:
            raise FileNotFoundError(str(exc)) from exc
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

    def request_stop(self) -> float:
        self._stop.set()
        return time.monotonic() + 2.5

    def close(self, *, deadline: float | None = None) -> bool:
        if deadline is None:
            deadline = self.request_stop()
        for thread, database in self._worker_lanes:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                LOGGER.warning("worker lane is still finishing", extra={"lane": thread.name})
            else:
                database.close()
        stopped = not any(thread.is_alive() for thread, _ in self._worker_lanes)
        if stopped:
            self.database.close()
        return stopped


__all__ = [
    "TypedJobManager",
    "performance_refresh_needed",
    "reconcile_watchlist_after_job",
    "stage_specs",
]
