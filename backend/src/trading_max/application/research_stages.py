"""Durable worker stages for typed market research."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress

from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
    StoredSnapshot,
)
from trading_max.research.fundamentals import (
    AnalystBatch,
    EarningsBatch,
    FinancialsBatch,
    ResearchDataError,
    ValuationBatch,
    YFinanceResearchService,
    build_valuation,
)
from trading_max.research.market import (
    MarketResearchService,
    OptionsResearchBatch,
    TechnicalResearchBatch,
)

from .errors import StageExecutionError
from .stages import StageContext, StageResult


def _upstream_json(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    key: str,
):
    for artifact_id in context.upstream_artifact_ids:
        try:
            ref = artifacts.get_ref(artifact_id)
            if ref.media_type != "application/json":
                continue
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == key:
            return stored
    return None


def _quality_status(warnings: list[str]) -> str:
    return "warning" if warnings else "verified"


def _canonical(ticker: str) -> str:
    value = str(ticker or "").upper()
    return value[:-2] if value.endswith(".L") else value


MERGEABLE_RESEARCH_KEYS = frozenset(
    {
        "research/market_snapshot.json",
        "research/technical.json",
        "research/options.json",
        "research/adr.json",
        "research/fundamentals.json",
        "research/valuation.json",
        "research/earnings.json",
        "research/analyst.json",
        "research/financials.json",
    }
)


def merge_partial_rows(
    previous: dict | None,
    payload: dict,
    *,
    refreshed: tuple[str, ...],
) -> dict:
    """Carry forward rows for tickers a partial research job did not refresh.

    Research artifacts are whole-file replacements keyed by artifact key, so a
    single-ticker refresh would otherwise publish a snapshot containing only
    that ticker and silently drop every other watchlist row. A partial job must
    only ever replace the tickers it actually recomputed.
    """

    if previous is None or not refreshed:
        return payload
    previous_rows = previous.get("rows")
    new_rows = payload.get("rows")
    if not isinstance(previous_rows, list) or not isinstance(new_rows, list):
        return payload
    replaced = {_canonical(ticker) for ticker in refreshed}
    # Anything the job recomputed is authoritative, including a ticker that
    # legitimately produced no row this run.
    carried = [
        row
        for row in previous_rows
        if isinstance(row, dict)
        and _canonical(str(row.get("ticker") or row.get("t") or "")) not in replaced
    ]
    if not carried:
        return payload
    merged = dict(payload)
    merged["rows"] = [*carried, *new_rows]
    previous_tickers = previous.get("tickers")
    new_tickers = payload.get("tickers")
    if isinstance(previous_tickers, list) and isinstance(new_tickers, list):
        merged["tickers"] = list(dict.fromkeys([*previous_tickers, *new_tickers]))
    return merged


def merge_partial_market_snapshot(
    previous: dict | None,
    payload: dict,
    *,
    refreshed: tuple[str, ...],
) -> dict:
    """Merge the nested technical/options rows of a partial market snapshot."""

    if previous is None or not refreshed:
        return payload
    merged = dict(payload)
    for section in ("technical", "options"):
        previous_section = previous.get(section)
        current_section = payload.get(section)
        if not isinstance(previous_section, dict) or not isinstance(current_section, dict):
            continue
        merged_section = merge_partial_rows(
            previous_section,
            current_section,
            refreshed=refreshed,
        )
        if merged_section is not current_section:
            merged[section] = merged_section
    previous_tickers = previous.get("tickers")
    current_tickers = payload.get("tickers")
    if isinstance(previous_tickers, list) and isinstance(current_tickers, list):
        merged["tickers"] = list(dict.fromkeys([*previous_tickers, *current_tickers]))
    return merged


class MarketSnapshotStage:
    """Fetch the watchlist once and publish a reusable market input artifact."""

    name = "market.snapshot"
    version = "market-snapshot-v4"
    required_for = frozenset({"all", "research"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: MarketResearchService | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.service = service or MarketResearchService()

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "market snapshot requires a non-empty watchlist",
            )
        try:
            technical, options = self.service.run(context.tickers)
        except Exception as exc:
            raise StageExecutionError(
                "market.snapshot_failed",
                str(exc),
                retryable=True,
            ) from exc
        warnings = list(dict.fromkeys(technical.warnings + options.warnings))
        payload = {
            "schema_version": 1,
            "artifact_type": "market_snapshot_input",
            "as_of": technical.as_of,
            "generated_at": technical.generated_at.isoformat(),
            "tickers": technical.tickers,
            "technical": technical.model_dump(mode="json", by_alias=False),
            "options": options.model_dump(mode="json", by_alias=False),
        }
        artifact = self.artifacts.put_json(
            key="research/market_snapshot.json",
            payload=payload,
            kind="market",
            as_of=technical.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(warnings),
                coverage=f"{len(technical.rows)}/{len(technical.tickers)}",
                warnings=warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(warnings),
            metadata={"as_of": technical.as_of},
        )


class TechnicalResearchStage:
    """Publish technical and options batches from one typed provider call."""

    name = "research.technical"
    version = "technical-v2"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: MarketResearchService | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.service = service or MarketResearchService()

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "technical research requires a non-empty watchlist",
            )
        try:
            technical, options = self.service.run(context.tickers)
        except Exception as exc:
            if isinstance(exc, StageExecutionError):
                raise
            raise StageExecutionError(
                "research.technical_failed",
                str(exc),
                retryable=True,
            ) from exc

        quality_status = "warning" if technical.warnings else "verified"
        technical_artifact = self.artifacts.put_json(
            key="research/technical.json",
            payload=technical.model_dump(mode="json", by_alias=False),
            kind="technical",
            as_of=technical.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=quality_status,
                coverage=f"{len(technical.rows)}/{len(technical.tickers)}",
                warnings=technical.warnings,
            ),
        )
        options_artifact = self.artifacts.put_json(
            key="research/options.json",
            payload=options.model_dump(mode="json", by_alias=False),
            kind="options",
            as_of=options.as_of,
            producer_version="options-v1",
            dependency_artifact_ids=[technical_artifact.ref.artifact_id],
            quality=ArtifactQuality(
                status="warning" if options.warnings else "verified",
                coverage=f"{len(options.rows)}/{len(options.tickers)}",
                warnings=options.warnings,
            ),
        )
        return StageResult(
            artifacts=(technical_artifact.ref, options_artifact.ref),
            warnings=tuple(technical.warnings),
            metadata={"as_of": technical.as_of},
        )


class TechnicalArtifactStage:
    """Project technical rows from the immutable market input."""

    name = "research.technical"
    version = "technical-v5"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.market_dependency_missing",
                "technical research requires the current market snapshot",
            )
        try:
            batch = TechnicalResearchBatch.model_validate(source.payload["technical"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.technical_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/technical.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="technical",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class OptionsArtifactStage:
    """Project options positioning from the same market input as technical."""

    name = "research.options"
    version = "options-v2"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.market_dependency_missing",
                "options research requires the current market snapshot",
            )
        try:
            batch = OptionsResearchBatch.model_validate(source.payload["options"])
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.options_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/options.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="options",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(artifacts=(artifact.ref,), warnings=tuple(batch.warnings))


class AdrArtifactStage:
    """Publish ADR parity research without splicing home-market prices."""

    name = "research.adr"
    version = "adr-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical",)

    def __init__(self, artifacts: ContentAddressedArtifactStore) -> None:
        self.artifacts = artifacts

    def run(self, context: StageContext) -> StageResult:
        source = _upstream_json(
            self.artifacts,
            context,
            "research/technical.json",
        )
        if source is None:
            raise StageExecutionError(
                "research.technical_dependency_missing",
                "ADR research requires technical research",
            )
        rows = [
            {
                "ticker": row["ticker"],
                "adr_research": row["adr_research"],
            }
            for row in source.payload.get("rows", [])
            if isinstance(row, dict) and row.get("adr_research")
        ]
        payload = {
            "schema_version": 1,
            "artifact_type": "adr_research_batch",
            "as_of": source.payload.get("as_of"),
            "generated_at": source.payload.get("generated_at"),
            "tickers": [row["ticker"] for row in rows],
            "rows": rows,
            "warnings": [],
        }
        artifact = self.artifacts.put_json(
            key="research/adr.json",
            payload=payload,
            kind="adr",
            as_of=str(source.payload.get("as_of") or "") or None,
            producer_version=self.version,
            dependency_artifact_ids=[source.ref.artifact_id],
            quality=ArtifactQuality(
                status="verified",
                coverage=f"{len(rows)}/{len(context.tickers)} ADRs",
            ),
        )
        return StageResult(artifacts=(artifact.ref,))


class FundamentalsArtifactStage:
    """Fetch and normalize fundamentals for the current watchlist."""

    name = "research.fundamentals"
    version = "fundamentals-v2"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "fundamentals research requires a non-empty watchlist",
            )
        market = _upstream_json(
            self.artifacts,
            context,
            "research/market_snapshot.json",
        )
        as_of = str(market.payload.get("as_of")) if market else None
        try:
            batch = self.service.fundamentals(context.tickers, as_of=as_of)
        except ResearchDataError as exc:
            raise StageExecutionError(
                "research.fundamentals_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/fundamentals.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="fundamentals",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class FinancialsArtifactStage:
    """Fetch annual and quarterly financial statements."""

    name = "research.financials"
    version = "financials-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "financials research requires a non-empty watchlist",
            )
        try:
            batch = self.service.financials(context.tickers)
            FinancialsBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.financials_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/financials.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="financials",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class AnalystArtifactStage:
    """Fetch analyst consensus estimates, ratings and target prices."""

    name = "research.analyst"
    version = "analyst-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "analyst research requires a non-empty watchlist",
            )
        try:
            batch = self.service.analyst(context.tickers)
            AnalystBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.analyst_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/analyst.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="analyst",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class ValuationArtifactStage:
    """Calculate evidence-gated scenario valuation lenses.

    Versioned assumptions override sector defaults when present. Provider free
    cash flow is handled as a levered proxy paired with cost of equity; analyst
    targets remain an independent reference rather than a numeric fallback.
    """

    name = "research.valuation"
    version = "valuation-v4"
    required_for = frozenset({"all", "research"})
    dependencies = ("research.technical", "research.fundamentals")

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore | None = None,
        *,
        fx_loader=None,
        assumptions_store=None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.fx_loader = fx_loader
        self.assumptions_store = assumptions_store

    def _previous_assumptions(self) -> dict | None:
        store = self.assumptions_store
        if store is not None:
            try:
                payload = store.to_snapshot_payload()
                if payload.get("companies"):
                    return payload
            except Exception:
                return None
        if self.snapshots is None:
            return None
        previous = self.snapshots.latest()
        if previous is None:
            return None
        ref = next(
            (
                item
                for item in previous.manifest.artifacts
                if item.key == "research/valuation_assumptions.json"
            ),
            None,
        )
        if ref is None:
            return None
        try:
            return self.artifacts.get_json(ref.artifact_id).payload
        except (FileNotFoundError, KeyError, ValueError):
            return None

    def run(self, context: StageContext) -> StageResult:
        technical = _upstream_json(
            self.artifacts,
            context,
            "research/technical.json",
        )
        fundamentals = _upstream_json(
            self.artifacts,
            context,
            "research/fundamentals.json",
        )
        if technical is None or fundamentals is None:
            raise StageExecutionError(
                "research.valuation_dependency_missing",
                "valuation requires current technical and fundamentals artifacts",
            )
        try:
            batch = build_valuation(
                technical.payload,
                fundamentals.payload,
                assumptions=self._previous_assumptions(),
                fx_loader=self.fx_loader,
            )
            ValuationBatch.model_validate(batch.model_dump(mode="json"))
        except (KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.valuation_invalid_input",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/valuation.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="valuation",
            as_of=batch.as_of,
            producer_version=self.version,
            dependency_artifact_ids=[
                technical.ref.artifact_id,
                fundamentals.ref.artifact_id,
            ],
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        artifacts = [artifact.ref]
        store = self.assumptions_store
        if store is not None:
            assumptions_payload = store.to_snapshot_payload()
            assumptions_artifact = self.artifacts.put_json(
                key="research/valuation_assumptions.json",
                payload=assumptions_payload,
                kind="assumptions",
                as_of=str(assumptions_payload.get("as_of") or "") or None,
                producer_version="valuation-assumptions-v2",
            )
            artifacts.append(assumptions_artifact.ref)
        return StageResult(
            artifacts=tuple(artifacts),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class EarningsArtifactStage:
    """Publish earnings calendar data with explicit source quality."""

    name = "research.earnings"
    version = "earnings-v1"
    required_for = frozenset({"all", "research"})
    dependencies = ("market.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        service: YFinanceResearchService,
    ) -> None:
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        if not context.tickers:
            raise StageExecutionError(
                "research.empty_universe",
                "earnings research requires a non-empty watchlist",
            )
        try:
            batch = self.service.earnings(context.tickers)
            EarningsBatch.model_validate(batch.model_dump(mode="json"))
        except (ResearchDataError, KeyError, TypeError, ValueError) as exc:
            raise StageExecutionError(
                "research.earnings_failed",
                str(exc),
                retryable=True,
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/earnings.json",
            payload=batch.model_dump(mode="json", by_alias=False),
            kind="earnings",
            as_of=batch.as_of,
            producer_version=self.version,
            quality=ArtifactQuality(
                status=_quality_status(batch.warnings),
                coverage=f"{len(batch.rows)}/{len(batch.tickers)}",
                warnings=batch.warnings,
            ),
        )
        return StageResult(
            artifacts=(artifact.ref,),
            warnings=tuple(batch.warnings),
            metadata={"as_of": batch.as_of},
        )


class TypedPublishSnapshotStage:
    """Publish the exact artifact IDs produced by preceding typed stages."""

    name = "snapshot.publish"
    version = "snapshot-v1"
    required_for = frozenset({"all", "accounts", "research", "intraday", "cfd"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        on_snapshot_published: Callable[[StoredSnapshot, str], None] | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.on_snapshot_published = on_snapshot_published

    def _merge_partial_research(
        self,
        new_refs: list,
        *,
        previous,
        context: StageContext,
    ) -> list:
        """Preserve rows for tickers a partial research refresh did not touch.

        A per-ticker refresh recomputes the research artifacts for that ticker
        only. Publishing those rows verbatim would replace the whole-watchlist
        artifact with a single row and make every other ticker look unresearched.
        """

        if previous is None or context.scope != "research" or not context.tickers:
            return new_refs
        previous_by_key = {ref.key: ref for ref in previous.manifest.artifacts}
        merged_refs = []
        for ref in new_refs:
            if ref.key not in MERGEABLE_RESEARCH_KEYS:
                merged_refs.append(ref)
                continue
            previous_ref = previous_by_key.get(ref.key)
            if previous_ref is None:
                merged_refs.append(ref)
                continue
            try:
                previous_payload = self.artifacts.get_json(previous_ref.artifact_id).payload
                current = self.artifacts.get_json(ref.artifact_id)
            except (FileNotFoundError, KeyError, ValueError):
                merged_refs.append(ref)
                continue
            if ref.key == "research/market_snapshot.json":
                merged_payload = merge_partial_market_snapshot(
                    previous_payload,
                    current.payload,
                    refreshed=context.tickers,
                )
            else:
                merged_payload = merge_partial_rows(
                    previous_payload,
                    current.payload,
                    refreshed=context.tickers,
                )
            if merged_payload is current.payload:
                merged_refs.append(ref)
                continue
            merged_refs.append(
                self.artifacts.put_json(
                    key=ref.key,
                    payload=merged_payload,
                    kind=ref.kind,
                    as_of=ref.as_of,
                    producer_version=ref.producer_version,
                    quality=ref.quality,
                ).ref
            )
        return merged_refs

    def run(self, context: StageContext) -> StageResult:
        if not context.upstream_artifact_ids:
            raise StageExecutionError(
                "snapshot.empty",
                "cannot publish a snapshot without upstream artifacts",
            )
        new_refs = [
            self.artifacts.get_ref(artifact_id) for artifact_id in context.upstream_artifact_ids
        ]
        refs_by_key = {}
        previous = self.snapshots.latest()
        if previous is not None:
            refs_by_key.update({ref.key: ref for ref in previous.manifest.artifacts})
        new_refs = self._merge_partial_research(
            new_refs,
            previous=previous,
            context=context,
        )
        refs_by_key.update({ref.key: ref for ref in new_refs})
        refs = list(refs_by_key.values())
        published = self.snapshots.publish(
            scope=context.scope,
            source=f"{context.trigger}:{context.job_id}",
            artifacts=refs,
        )
        if self.on_snapshot_published is not None and context.trigger != "intraday":
            # Synthesis is additive. A provider or queue outage must not
            # invalidate an otherwise complete portfolio snapshot.
            with suppress(Exception):
                self.on_snapshot_published(published, context.trigger)
        return StageResult(metadata={"snapshot_run_id": published.manifest.run_id})


__all__ = ["TechnicalResearchStage", "TypedPublishSnapshotStage"]
