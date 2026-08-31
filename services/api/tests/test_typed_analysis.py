from __future__ import annotations

from pathlib import Path

from trading_max.application import StageRegistry
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
)
from trading_max.synthesis.providers import FakeProvider
from trading_max.worker import DurableWorker

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import SecuritySearchResult
from services.api.trading_max_api.provider_runtime import ProviderRuntimeError
from services.api.trading_max_api.typed_analysis import TypedAnalysisManager
from services.api.trading_max_api.watchlist import WatchlistStore


class _FixtureContext:
    def build(self, manifest, lens, ticker):
        return {
            "snapshotRunId": manifest.run_id,
            "lens": lens,
            "ticker": ticker,
            "dashboard": {
                "totalValueGbp": 100,
                "holdings": [],
                "lookthrough": {},
            },
        }


def _manager(state: Path) -> TypedAnalysisManager:
    return TypedAnalysisManager(
        ArtifactStore(state),
        WatchlistStore(state),
        provider="fake",
        model="trading_max-fake-v1",
        context_builder=_FixtureContext(),  # type: ignore[arg-type]
        synthesis_provider=FakeProvider(),
    )


def test_typed_analysis_prefers_persisted_provider_factory_at_startup(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    provider = FakeProvider()
    manager = TypedAnalysisManager(
        ArtifactStore(state),
        WatchlistStore(state),
        provider="deepseek",
        model="deepseek-v4-flash",
        provider_factory=lambda: provider,
    )
    try:
        assert manager.provider is provider
    finally:
        manager.close()


def _seed_snapshot(state: Path) -> None:
    artifacts = ContentAddressedArtifactStore(state / "artifacts")
    source = artifacts.put_json(
        key="research/fixture.json",
        payload={"as_of": "2026-08-07", "rows": []},
        kind="fixture",
        producer_version="test-v1",
    )
    SnapshotStore(state).publish(
        scope="research",
        source="typed-analysis-test",
        artifacts=[source],
    )


def test_typed_analysis_runs_in_worker_and_reuses_identical_artifact(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    _seed_snapshot(state)
    manager = _manager(state)
    worker = DurableWorker(
        manager.queue,
        StageRegistry([manager.stage()]),
        worker_id="analysis-test-worker",
    )
    try:
        first = manager.submit(lenses=["daily_cio_brief"], force=True)
        assert worker.run_once() is True
        completed = manager.get(first.run_id)
        assert completed.status.value == "succeeded"
        assert len(completed.artifact_ids) == 1
        first_artifact = manager.get_artifact(completed.artifact_ids[0])
        assert first_artifact.fake is True
        assert first_artifact.analysis_id == "daily_cio_brief"
        assert first_artifact.input_hash
        persisted = manager.artifacts.get_json(completed.artifact_ids[0]).payload
        assert persisted["analysis_id"] == "daily_cio_brief"
        assert "page" not in persisted

        second = manager.submit(lenses=["daily_cio_brief"])
        assert worker.run_once() is True
        cached = manager.get(second.run_id)
        assert cached.status.value == "succeeded"
        assert cached.cached is True
        assert cached.artifact_ids == completed.artifact_ids
    finally:
        worker.close()
        manager.close()


def test_typed_analysis_run_state_survives_manager_restart(tmp_path: Path) -> None:
    state = tmp_path / "state"
    _seed_snapshot(state)
    first = _manager(state)
    queued = first.submit(lenses=["daily_cio_brief"], force=True)
    first.close()

    second = _manager(state)
    worker = DurableWorker(
        second.queue,
        StageRegistry([second.stage()]),
        worker_id="analysis-restart-worker",
    )
    try:
        assert worker.run_once() is True
        assert second.get(queued.run_id).status.value == "succeeded"
    finally:
        worker.close()
        second.close()


def test_taxonomy_audit_is_not_exposed_as_analysis_artifact(tmp_path: Path) -> None:
    state = tmp_path / "state"
    _seed_snapshot(state)
    manager = _manager(state)
    item = manager.watchlist.add(
        SecuritySearchResult(
            ticker="BE",
            name="Bloom Energy Corp",
            exchange="NYSE",
            bloomberg_ticker="BE US Equity",
            figi="",
        )
    )
    manager.taxonomy_workflow.record_pending(item, provider_available=True)
    worker = DurableWorker(
        manager.queue,
        StageRegistry([manager.stage()]),
        worker_id="taxonomy-artifact-boundary-worker",
    )
    try:
        submitted = manager.submit(lenses=["watchlist_opportunity_map"], force=True)
        assert worker.run_once() is True
        completed = manager.get(submitted.run_id)
        assert completed.status.value == "succeeded"
        assert len(completed.artifact_ids) == 1
        assert manager.get_artifact(completed.artifact_ids[0]).analysis_id == (
            "watchlist_opportunity_map"
        )
        assert manager.watchlist.items()[0].taxonomy_status == "unclassified"
        taxonomy_audits = list((state / "taxonomy-workflows" / "BE").glob("*.json"))
        assert len(taxonomy_audits) == 2
    finally:
        worker.close()
        manager.close()


def test_taxonomy_finishes_even_when_opportunity_synthesis_fails(tmp_path: Path) -> None:
    state = tmp_path / "state"
    _seed_snapshot(state)
    manager = _manager(state)
    item = manager.watchlist.add(
        SecuritySearchResult(
            ticker="GOOGL",
            name="Alphabet Inc Class A",
            exchange="NASDAQ",
            bloomberg_ticker="GOOGL US Equity",
            figi="",
        )
    )
    manager.taxonomy_workflow.record_pending(item, provider_available=True)

    def fail_synthesis(*_args, **_kwargs):
        raise RuntimeError("synthetic opportunity-map failure")

    manager.synthesis.analyze = fail_synthesis  # type: ignore[method-assign]
    try:
        submitted = manager.submit(lenses=["watchlist_opportunity_map"], force=True)
        manager.execute(submitted.run_id, force=True)
        completed = manager.get(submitted.run_id)
        assert completed.status.value == "failed"
        assert completed.artifact_ids == []
        assert manager.watchlist.items()[0].taxonomy_status == "unclassified"
        assert manager.watchlist.items()[0].taxonomy_decision_id
    finally:
        manager.close()


def test_taxonomy_route_loss_records_unclassified_instead_of_staying_classifying(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    _seed_snapshot(state)

    def provider_factory(workload: str | None = None):
        if workload == "taxonomy":
            raise ProviderRuntimeError("provider_unavailable", "taxonomy route unavailable")
        return FakeProvider()

    manager = TypedAnalysisManager(
        ArtifactStore(state),
        WatchlistStore(state),
        provider="fake",
        model="trading_max-fake-v1",
        context_builder=_FixtureContext(),  # type: ignore[arg-type]
        provider_factory=provider_factory,
    )
    item = manager.watchlist.add(
        SecuritySearchResult(
            ticker="BE",
            name="Bloom Energy Corp",
            exchange="NYSE",
            bloomberg_ticker="BE US Equity",
            figi="",
        )
    )
    manager.taxonomy_workflow.record_pending(item, provider_available=True)
    try:
        submitted = manager.submit(lenses=["watchlist_opportunity_map"], force=True)
        manager.execute(submitted.run_id, force=True)
        completed = manager.get(submitted.run_id)
        assert completed.status.value == "failed"
        classified = manager.watchlist.items()[0]
        assert classified.taxonomy_status == "unclassified"
        assert classified.taxonomy_version is None
        assert classified.taxonomy_decision_id
    finally:
        manager.close()
