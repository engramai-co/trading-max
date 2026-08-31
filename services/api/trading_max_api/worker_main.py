"""Dedicated macOS worker entry point for Trading Max refresh jobs."""

from __future__ import annotations

import logging
import os
import signal
import threading
from pathlib import Path

from trading_max.application import TypedWorkerRuntime
from trading_max.domain import JobStatus
from trading_max.infrastructure import SqliteDatabase, SqliteJobQueue
from trading_max.worker import DurableWorker

from .artifacts import ArtifactStore
from .config import Settings
from .credentials import default_credential_store
from .provider_runtime import make_provider_factory
from .settings import SettingsRepository
from .typed_analysis import TypedAnalysisManager
from .typed_jobs import performance_refresh_needed, reconcile_watchlist_after_job, stage_specs
from .valuation_assumptions import ValuationAssumptionsStore
from .watchlist import WatchlistStore

LOGGER = logging.getLogger("trading_max.worker")
MIGRATIONS = Path(__file__).resolve().parents[3] / "backend" / "migrations"


def _run_typed_worker(settings: Settings) -> None:
    """Run the production stage registry without subprocess imports."""

    store = ArtifactStore(settings.data_root)
    watchlist = WatchlistStore(settings.data_root)
    valuation_assumptions = ValuationAssumptionsStore(settings.data_root)
    preferences = SettingsRepository(settings.data_root)
    credentials = default_credential_store()
    analysis = TypedAnalysisManager(
        store,
        watchlist,
        provider=settings.llm_provider,
        model=settings.llm_model,
        openai_api_key=settings.openai_api_key,
        openai_base_url=settings.openai_base_url,
        deepseek_api_key=settings.deepseek_api_key,
        deepseek_base_url=settings.deepseek_base_url,
        provider_factory=make_provider_factory(settings, preferences, credentials),
    )
    database = SqliteDatabase(
        store.data_root / "trading_max.db",
        migrations_dir=MIGRATIONS,
    )
    queue = SqliteJobQueue(database)
    analysis_database = SqliteDatabase(
        store.data_root / "trading_max.db",
        migrations_dir=MIGRATIONS,
    )
    analysis_queue = SqliteJobQueue(analysis_database)

    def on_snapshot_published(snapshot, trigger: str) -> None:
        if trigger in {"intraday", "live"}:
            return
        try:
            analysis.submit(
                lenses=(
                    ["watchlist_opportunity_map"] if snapshot.manifest.scope == "research" else None
                ),
                snapshot_run_id=snapshot.manifest.run_id,
                trigger="nightly" if trigger == "nightly" else "snapshot",
            )
        except Exception:
            LOGGER.exception("failed to enqueue additive snapshot synthesis")

    runtime = TypedWorkerRuntime(
        store.data_root,
        intraday_interval_seconds=settings.intraday_interval_seconds,
        intraday_retention_days=settings.intraday_retention_days,
        on_snapshot_published=on_snapshot_published,
        extra_stages=(analysis.stage(),),
        valuation_assumptions=valuation_assumptions,
    )
    registry = runtime.registry()

    def on_finished(status: JobStatus, claimed) -> None:
        try:
            reconcile_watchlist_after_job(
                status,
                claimed.record,
                store=store,
                watchlist=watchlist,
            )
        except Exception:
            LOGGER.exception("failed to reconcile watchlist research status")
        if status != JobStatus.SUCCEEDED:
            return
        if claimed.record.trigger in {"intraday", "live"} and performance_refresh_needed(store):
            already_pending = any(
                record.scope == "accounts"
                and record.trigger == "performance"
                and not record.skip_sync
                and record.status in {JobStatus.QUEUED, JobStatus.RUNNING}
                for record in queue.list(limit=5_000)
            )
            if already_pending:
                LOGGER.info("structural account follow-up already pending")
            else:
                try:
                    queue.enqueue(
                        "accounts",
                        trigger="performance",
                        skip_sync=False,
                        stages=stage_specs(registry, "accounts", skip_sync=False),
                    )
                except Exception:
                    LOGGER.exception("failed to enqueue structural account follow-up")
        follow_up = queue.consume_follow_up(claimed.record.job_id)
        if follow_up is not None:
            try:
                queue.enqueue(
                    "research",
                    trigger="on_demand",
                    skip_sync=True,
                    tickers=follow_up,
                    stages=stage_specs(
                        registry,
                        "research",
                        skip_sync=True,
                    ),
                )
            except Exception:
                LOGGER.exception("failed to enqueue coalesced research follow-up")

    worker = DurableWorker(
        queue,
        registry,
        worker_id=os.environ.get("TRADING_MAX_WORKER_ID") or None,
        lease_seconds=settings.worker_lease_seconds,
        on_job_finished=on_finished,
        allowed_triggers=(
            "on_demand",
            "nightly",
            "intraday",
            "live",
            "performance",
            "research",
            "reconciliation",
        ),
    )
    analysis_worker = DurableWorker(
        analysis_queue,
        registry,
        worker_id=f"{worker.worker_id}-analysis",
        lease_seconds=settings.worker_lease_seconds,
        on_job_finished=on_finished,
        allowed_triggers=("system",),
    )
    stop = threading.Event()

    def request_stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    poll_seconds = settings.worker_poll_seconds
    analysis_thread = threading.Thread(
        target=_worker_loop,
        args=(analysis_worker, stop, poll_seconds),
        name="trading-max-analysis-worker",
        daemon=True,
    )
    analysis_thread.start()
    LOGGER.info(
        "typed workers started",
        extra={
            "worker_id": worker.worker_id,
            "analysis_worker_id": analysis_worker.worker_id,
        },
    )
    try:
        while not stop.is_set():
            if worker.run_once():
                continue
            stop.wait(max(0.1, min(poll_seconds, 60.0)))
    finally:
        stop.set()
        analysis_thread.join(timeout=5.0)
        worker.close()
        preferences.close()
        database.close()
        if analysis_thread.is_alive():
            LOGGER.warning(
                "analysis worker is still finishing external work; "
                "process shutdown will stop its daemon thread"
            )
        else:
            analysis_worker.close()
            analysis.close()
            analysis_database.close()
        LOGGER.info("typed workers stopped")


def _worker_loop(
    worker: DurableWorker,
    stop: threading.Event,
    poll_seconds: float,
) -> None:
    """Run one trigger-isolated worker until the shared stop signal is set."""

    while not stop.is_set():
        if worker.run_once():
            continue
        stop.wait(max(0.1, min(poll_seconds, 60.0)))


def main() -> None:
    settings = Settings.from_env()
    settings.validate_runtime_mode()
    _run_typed_worker(settings)


if __name__ == "__main__":
    main()
