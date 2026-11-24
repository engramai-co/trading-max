"""Dedicated worker entry point for Trading Max refresh jobs."""

from __future__ import annotations

import logging
import os
import signal
import threading

from .artifacts import ArtifactStore
from .broker_runtime import broker_profiles_loader
from .config import Settings
from .credentials import default_credential_store
from .market_data_runtime import reconstruction_loader_factory
from .provider_runtime import make_provider_factory
from .settings import SettingsRepository
from .typed_analysis import TypedAnalysisManager
from .typed_jobs import TypedJobManager
from .valuation_assumptions import ValuationAssumptionsStore
from .watchlist import WatchlistStore

LOGGER = logging.getLogger("trading_max.worker")


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
        enabled=settings.llm_analysis_enabled,
    )

    def on_snapshot_published(snapshot, trigger: str) -> None:
        if not analysis.enabled or trigger in {"intraday", "live"}:
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

    jobs = TypedJobManager(
        store,
        watchlist,
        assistant_enabled=lambda: preferences.get_profile().assistant_enabled,
        broker_profiles_loader=broker_profiles_loader(preferences),
        intraday_interval_seconds=settings.intraday_interval_seconds,
        intraday_retention_days=settings.intraday_retention_days,
        on_snapshot_published=on_snapshot_published,
        analysis_stage=analysis.stage(),
        valuation_assumptions=valuation_assumptions,
        intraday_history_loader_factory=reconstruction_loader_factory(
            settings.data_root, preferences, credentials
        ),
    )
    stop = threading.Event()

    def request_stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    main_lane = jobs.start_worker_lanes(
        worker_id=os.environ.get("TRADING_MAX_WORKER_ID") or None,
        lease_seconds=settings.worker_lease_seconds,
        poll_seconds=settings.worker_poll_seconds,
    )
    LOGGER.info("typed workers started", extra={"worker_id": main_lane.name})
    try:
        while main_lane.is_alive() and not stop.wait(0.2):
            pass
        if not stop.is_set():
            raise RuntimeError("main worker lane stopped unexpectedly")
    finally:
        if jobs.close():
            analysis.close()
            preferences.close()
        LOGGER.info("typed workers stopped")


def main() -> None:
    settings = Settings.from_env()
    settings.validate_runtime_mode()
    _run_typed_worker(settings)


if __name__ == "__main__":
    main()
