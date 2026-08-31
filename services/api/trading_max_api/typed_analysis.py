"""Durable worker control plane for snapshot-bound LLM synthesis."""

from __future__ import annotations

import hashlib
import inspect
import json
import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from trading_max.application import StageResult
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SqliteDatabase,
    SqliteJobQueue,
)
from trading_max.synthesis import (
    AnalysisDefinition,
    SynthesisService,
)
from trading_max.synthesis.providers import create_provider
from trading_max.worker import StageExecutionError

from .analysis_context import (
    PORTFOLIO_LENSES,
    TICKER_LENSES,
    AnalysisContextBuilder,
)
from .analysis_lenses import page_for_lens
from .analysis_repository import AnalysisRunRepository
from .artifacts import ArtifactStore
from .models import (
    AnalysisArtifact,
    AnalysisContent,
    AnalysisLens,
    AnalysisRunRecord,
    AnalysisStatus,
    AnalysisTrigger,
)
from .taxonomy_workflow import TaxonomyWorkflowManager
from .watchlist import WatchlistStore

LOGGER = logging.getLogger(__name__)
MIGRATIONS = Path(__file__).resolve().parents[3] / "backend" / "migrations"

DEFINITIONS: dict[AnalysisLens, AnalysisDefinition] = {
    "daily_cio_brief": AnalysisDefinition(
        analysis_id="daily_cio_brief",
        title="Daily CIO portfolio brief",
        prompt_version="v5",
    ),
    "hidden_exposure": AnalysisDefinition(
        analysis_id="hidden_exposure",
        title="Look-through concentration and hidden exposure review",
        prompt_version="v5",
    ),
    "return_attribution": AnalysisDefinition(
        analysis_id="return_attribution",
        title="Performance, drawdown, and trading-quality attribution",
        prompt_version="v6",
    ),
    "watchlist_opportunity_map": AnalysisDefinition(
        analysis_id="watchlist_opportunity_map",
        title="Cross-sectional watchlist opportunity map",
        prompt_version="v5",
    ),
    "technical_regime": AnalysisDefinition(
        analysis_id="technical_regime",
        title="Multi-timeframe technical regime and key levels",
        prompt_version="v5",
    ),
    "valuation_scenario": AnalysisDefinition(
        analysis_id="valuation_scenario",
        title="Bull, base, and bear valuation interpretation",
        prompt_version="v5",
    ),
    "fundamental_health": AnalysisDefinition(
        analysis_id="fundamental_health",
        title="Financial statements, margins, cash flow, and consensus",
        prompt_version="v5",
    ),
    "analyst_consensus": AnalysisDefinition(
        analysis_id="analyst_consensus",
        title="Analyst targets, ratings, estimates, and estimate revisions",
        prompt_version="v1",
    ),
    "financial_statements": AnalysisDefinition(
        analysis_id="financial_statements",
        title="Annual and quarterly financial statement trends",
        prompt_version="v1",
    ),
    "options_positioning": AnalysisDefinition(
        analysis_id="options_positioning",
        title="Options walls, gamma, volatility, and positioning",
        prompt_version="v5",
    ),
    "thesis_change": AnalysisDefinition(
        analysis_id="thesis_change",
        title="Thesis memory, contradiction, and change detector",
        prompt_version="v5",
    ),
}


def _hash_payload(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


class TypedSynthesisStage:
    """Execute one analysis request inside the shared durable worker."""

    name = "synthesis.llm"
    version = "llm-synthesis-v2"
    required_for = frozenset({"research"})
    dependencies: tuple[str, ...] = ()

    def __init__(self, manager: TypedAnalysisManager) -> None:
        self.manager = manager

    def run(self, context: Any) -> StageResult:
        try:
            record = self.manager.get(context.job_id)
            self.manager.execute(context.job_id, force=record.force)
            record = self.manager.get(context.job_id)
        except Exception as exc:
            raise StageExecutionError(
                "synthesis.unhandled",
                f"analysis run {context.job_id} failed: {exc}",
            ) from exc
        if record.status == AnalysisStatus.FAILED:
            raise StageExecutionError(
                "synthesis.failed",
                "; ".join(record.errors) or "analysis failed",
            )
        refs = tuple(
            self.manager.artifacts.get_ref(artifact_id) for artifact_id in record.artifact_ids
        )
        return StageResult(
            artifacts=refs,
            warnings=tuple(record.errors),
            metadata={
                "analysis_run_id": record.run_id,
                "analysis_status": record.status.value,
            },
        )


class TypedAnalysisManager:
    """Admission, status, and artifact facade for typed analysis jobs."""

    def __init__(
        self,
        store: ArtifactStore,
        watchlist: WatchlistStore,
        *,
        provider: str,
        model: str,
        openai_api_key: str | None = None,
        openai_base_url: str = "https://api.openai.com/v1",
        deepseek_api_key: str | None = None,
        deepseek_base_url: str = "https://api.deepseek.com",
        provider_factory: Callable[[str | None], Any] | Callable[[], Any] | None = None,
        context_builder: AnalysisContextBuilder | None = None,
        synthesis_provider: Any | None = None,
    ) -> None:
        self.store = store
        self.watchlist = watchlist
        self.contexts = context_builder or AnalysisContextBuilder(store, watchlist)
        self.artifacts: ContentAddressedArtifactStore = store.immutable_artifacts
        self.database = SqliteDatabase(
            store.data_root / "trading_max.db",
            migrations_dir=MIGRATIONS,
        )
        self.repository = AnalysisRunRepository(self.database)
        self.queue = SqliteJobQueue(self.database)
        self._provider_factory = provider_factory
        if synthesis_provider is not None:
            self.provider = synthesis_provider
        elif provider_factory is not None:
            self.provider = self._call_provider_factory()
        else:
            self.provider = create_provider(
                provider=provider,
                model=model,
                openai_api_key=openai_api_key,
                openai_base_url=openai_base_url,
                deepseek_api_key=deepseek_api_key,
                deepseek_base_url=deepseek_base_url,
            )
        self.synthesis = SynthesisService(self.artifacts, self.provider)
        self.taxonomy_workflow = TaxonomyWorkflowManager(
            store.data_root,
            watchlist,
            self.artifacts,
        )
        self.repository.recover_interrupted(
            message="analysis worker restarted before the run completed"
        )

    def _call_provider_factory(self, workload: str | None = None) -> Any:
        if self._provider_factory is None:  # pragma: no cover - caller guard
            return self.provider
        try:
            parameters = inspect.signature(self._provider_factory).parameters.values()
            accepts_argument = any(
                parameter.kind
                in {
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.VAR_POSITIONAL,
                }
                for parameter in parameters
            )
        except (TypeError, ValueError):
            accepts_argument = True
        if accepts_argument:
            return self._provider_factory(workload)  # type: ignore[call-arg]
        return self._provider_factory()  # type: ignore[call-arg]

    @staticmethod
    def _workload_for_lens(lens: AnalysisLens) -> str:
        if lens == "watchlist_opportunity_map":
            return "taxonomy"
        return "portfolio" if lens in PORTFOLIO_LENSES else "ticker"

    def _provider_route(self) -> str:
        return getattr(
            self.provider,
            "route_id",
            f"{self.provider.name}/{self.provider.model}",
        )

    def reload_provider(self, workload: str | None = None) -> None:
        """Load the current settings revision for the next analysis task."""

        if self._provider_factory is None:
            return
        self.provider = self._call_provider_factory(workload)
        self.synthesis = SynthesisService(self.artifacts, self.provider)

    def provider_available(self, workload: str | None = None) -> bool:
        """Report route availability without mutating the active provider."""

        try:
            provider = (
                self._call_provider_factory(workload)
                if self._provider_factory is not None
                else self.provider
            )
        except Exception:
            return False
        return not bool(getattr(provider, "fake", False))

    def _validate_submission_routes(self, lenses: list[AnalysisLens]) -> None:
        """Resolve every route before admitting a run into the durable queue."""

        if self._provider_factory is None:
            return
        workloads = dict.fromkeys(self._workload_for_lens(lens) for lens in lenses)
        resolved = [self._call_provider_factory(workload) for workload in workloads]
        if resolved:
            self.provider = resolved[0]
            self.synthesis = SynthesisService(self.artifacts, self.provider)

    def stage(self) -> TypedSynthesisStage:
        return TypedSynthesisStage(self)

    def get(self, run_id: str) -> AnalysisRunRecord:
        return self.repository.get(run_id)

    def list(self, limit: int = 20) -> list[AnalysisRunRecord]:
        return self.repository.list(limit)

    def submit(
        self,
        *,
        lenses: list[AnalysisLens] | None = None,
        ticker: str | None = None,
        snapshot_run_id: str | None = None,
        trigger: AnalysisTrigger = "on_demand",
        force: bool = False,
    ) -> AnalysisRunRecord:
        manifest = (
            self.store.load_manifest(snapshot_run_id)
            if snapshot_run_id
            else self.store.latest_manifest()
        )
        if manifest is None:
            raise FileNotFoundError("no snapshot has been published")
        normalized_ticker = ticker.upper() if ticker else None
        selected_lenses = list(
            dict.fromkeys(lenses or (TICKER_LENSES if normalized_ticker else PORTFOLIO_LENSES))
        )
        if any(lens in TICKER_LENSES for lens in selected_lenses) and not normalized_ticker:
            raise ValueError("ticker is required for ticker-level analysis")
        try:
            self._validate_submission_routes(selected_lenses)
        except Exception:
            # A research snapshot must still enter the durable queue so the
            # taxonomy workflow can record an auditable no-provider decision.
            # Every other analysis submission keeps strict route admission.
            if selected_lenses != ["watchlist_opportunity_map"]:
                raise
        run = AnalysisRunRecord(
            run_id=secrets.token_hex(16),
            snapshot_run_id=manifest.run_id,
            trigger=trigger,
            status=AnalysisStatus.QUEUED,
            lenses=selected_lenses,
            ticker=normalized_ticker,
            provider=self.provider.name,
            model=self.provider.model,
            route=self._provider_route(),
            adapter=getattr(self.provider, "adapter", "unknown"),
            provider_revision=getattr(
                self.provider,
                "provider_revision",
                None,
            ),
            route_policy_revision=getattr(
                self.provider,
                "route_policy_revision",
                None,
            ),
            force=force,
            created_at=datetime.now(UTC),
        )
        self.repository.save(run)
        try:
            self.queue.enqueue(
                "research",
                trigger="system",
                skip_sync=True,
                tickers=[normalized_ticker] if normalized_ticker else [],
                stages=[(self.stage().name, self.stage().version, "LLM synthesis")],
                log_path=str(self.store.logs_root / "analysis" / f"{run.run_id}.log"),
                job_id=run.run_id,
            )
        except Exception as exc:
            run.status = AnalysisStatus.FAILED
            run.finished_at = datetime.now(UTC)
            run.errors.append(f"queue: {type(exc).__name__}: {exc}")
            self.repository.save(run)
            raise
        return run

    def _latest_id(
        self,
        snapshot_run_id: str,
        lens: AnalysisLens,
        ticker: str | None,
    ) -> str | None:
        return self.repository.latest_id(
            snapshot_run_id=snapshot_run_id,
            lens=lens,
            ticker=ticker,
        )

    def _set_latest(
        self,
        *,
        snapshot_run_id: str,
        lens: AnalysisLens,
        ticker: str | None,
        artifact_id: str,
        input_hash: str,
    ) -> None:
        self.repository.set_latest(
            snapshot_run_id=snapshot_run_id,
            lens=lens,
            ticker=ticker,
            artifact_id=artifact_id,
            input_hash=input_hash,
            updated_at=datetime.now(UTC),
        )

    def execute(self, run_id: str, *, force: bool) -> None:
        run = self.get(run_id)
        run.status = AnalysisStatus.RUNNING
        run.started_at = datetime.now(UTC)
        self.repository.save(run)
        cache_hits = 0
        try:
            manifest = self.store.load_manifest(run.snapshot_run_id)
            source_ids = [self.store.artifact_id(artifact) for artifact in manifest.artifacts]
            for lens in run.lenses:
                definition = DEFINITIONS[lens]
                try:
                    provider_error: Exception | None = None
                    taxonomy_provider: Any | None = self.provider
                    try:
                        self.reload_provider(self._workload_for_lens(lens))
                        taxonomy_provider = self.provider
                        run.provider = self.provider.name
                        run.model = self.provider.model
                        run.route = self._provider_route()
                        run.adapter = getattr(self.provider, "adapter", "unknown")
                        run.provider_revision = getattr(
                            self.provider,
                            "provider_revision",
                            None,
                        )
                        run.route_policy_revision = getattr(
                            self.provider,
                            "route_policy_revision",
                            None,
                        )
                    except Exception as exc:
                        if lens != "watchlist_opportunity_map":
                            raise
                        provider_error = exc
                        taxonomy_provider = None
                    context = self.contexts.build(manifest, lens, run.ticker)
                    if lens == "watchlist_opportunity_map":
                        # Taxonomy is a separate audited side effect. Execute it before
                        # ordinary synthesis so a schema/provider failure in the legacy
                        # opportunity-map lens can never leave a watchlist item stuck in
                        # ``classifying``. Its immutable decision artifacts deliberately
                        # do not enter AnalysisRunRecord.artifact_ids: those IDs are
                        # reserved for AnalysisArtifact payloads returned by get_artifact.
                        try:
                            self.taxonomy_workflow.execute(context, taxonomy_provider)
                        except Exception as exc:
                            run.errors.append(f"taxonomy_workflow: {type(exc).__name__}: {exc}")
                            self.repository.save(run)
                    if provider_error is not None:
                        raise provider_error
                    input_hash = _hash_payload(
                        {
                            "context": context,
                            "analysisId": definition.analysis_id,
                            "promptVersion": definition.prompt_version,
                            "provider": self.provider.name,
                            "model": self.provider.model,
                        }
                    )
                    previous_id = self._latest_id(run.snapshot_run_id, lens, run.ticker)
                    if not force and previous_id:
                        cached = self.get_artifact(previous_id)
                        if cached.input_hash == input_hash:
                            run.artifact_ids.append(previous_id)
                            cache_hits += 1
                            self.repository.save(run)
                            continue
                    stored = self.synthesis.analyze(
                        definition,
                        context,
                        input_artifact_ids=source_ids,
                        input_hash=input_hash,
                    )
                    artifact_id = stored.ref.artifact_id
                    run.artifact_ids.append(artifact_id)
                    self._set_latest(
                        snapshot_run_id=run.snapshot_run_id,
                        lens=lens,
                        ticker=run.ticker,
                        artifact_id=artifact_id,
                        input_hash=input_hash,
                    )
                    self.repository.save(run)
                except Exception as exc:
                    run.errors.append(f"{lens}: {type(exc).__name__}: {exc}")
                    self.repository.save(run)
        except Exception as exc:
            run.errors.append(f"context: {type(exc).__name__}: {exc}")
        run.cached = bool(run.lenses) and cache_hits == len(run.lenses)
        if run.errors and run.artifact_ids:
            run.status = AnalysisStatus.PARTIAL
        elif run.errors:
            run.status = AnalysisStatus.FAILED
        else:
            run.status = AnalysisStatus.SUCCEEDED
        run.finished_at = datetime.now(UTC)
        self.repository.save(run)

    def get_artifact(self, artifact_id: str) -> AnalysisArtifact:
        try:
            stored = self.artifacts.get_json(artifact_id)
        except FileNotFoundError:
            raise FileNotFoundError(f"analysis artifact not found: {artifact_id}") from None
        payload = stored.payload
        response = payload["response"]
        return AnalysisArtifact(
            artifact_id=artifact_id,
            analysis_id=payload["analysis_id"],
            page=payload.get("page") or page_for_lens(payload["analysis_id"]),
            ticker=payload.get("ticker"),
            snapshot_run_id=payload["snapshot_run_id"],
            generated_at=payload["generated_at"],
            provider=payload["provider"],
            model=payload["model"],
            route=payload.get(
                "route",
                f"{payload['provider']}/{payload['model']}",
            ),
            adapter=payload.get("adapter", "unknown"),
            provider_revision=payload.get("provider_revision"),
            route_policy_revision=payload.get("route_policy_revision"),
            prompt_version=payload["prompt_version"],
            input_hash=payload.get("input_hash", ""),
            confidence=response["confidence"],
            content=AnalysisContent.model_validate(response),
            source_refs=response.get("source_refs", []),
            usage=payload.get("usage", {}),
            latency_ms=payload.get("latency_ms", 0),
            fake=payload.get("fake", False),
        )

    def latest(
        self,
        *,
        lens: AnalysisLens,
        ticker: str | None = None,
        snapshot_run_id: str | None = None,
    ) -> AnalysisArtifact:
        manifest = (
            self.store.load_manifest(snapshot_run_id)
            if snapshot_run_id
            else self.store.latest_manifest()
        )
        if manifest is None:
            raise FileNotFoundError("no snapshot has been published")
        artifact_id = self._latest_id(manifest.run_id, lens, ticker)
        if artifact_id is None:
            raise FileNotFoundError(f"no {lens} analysis for snapshot {manifest.run_id}")
        return self.get_artifact(artifact_id)

    def close(self) -> None:
        self.database.close()


__all__ = ["DEFINITIONS", "TypedAnalysisManager", "TypedSynthesisStage"]
