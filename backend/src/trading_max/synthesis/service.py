"""Persist structured synthesis results as immutable, snapshot-bound artifacts."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from pydantic import Field

from trading_max.domain import ArtifactQuality, DomainModel
from trading_max.domain.contracts import utc_now
from trading_max.infrastructure import ContentAddressedArtifactStore, StoredArtifact

from .contracts import (
    AnalysisDefinition,
    SynthesisResponse,
    SynthesisResult,
)
from .normalization import normalize_response
from .providers.base import SynthesisProvider


class SynthesisArtifact(DomainModel):
    schema_version: int = 1
    generated_at: datetime = Field(default_factory=utc_now)
    analysis_id: str
    # Retained only as optional provenance for artifacts written by pre-lens
    # deployments. Artifact identity and storage are always lens-based.
    page: str | None = None
    ticker: str | None = None
    snapshot_run_id: str
    input_hash: str = ""
    provider: str
    model: str
    route: str = "fake/trading-max-fake-v1"
    adapter: str = "unknown"
    provider_revision: int | None = Field(default=None, ge=1)
    route_policy_revision: int | None = Field(default=None, ge=1)
    prompt_version: str
    response: SynthesisResponse
    usage: dict[str, int] = Field(default_factory=dict)
    latency_ms: int = 0
    fake: bool = False


def _safe_component(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return normalized.strip("-") or "portfolio"


class SynthesisService:
    """Call one structured provider and persist its validated response."""

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        provider: SynthesisProvider,
    ) -> None:
        self.artifacts = artifacts
        self.provider = provider

    def analyze(
        self,
        definition: AnalysisDefinition,
        context: Mapping[str, Any],
        *,
        input_artifact_ids: Sequence[str] = (),
        input_hash: str = "",
    ) -> StoredArtifact:
        result = self.provider.analyze(definition, dict(context))
        if not isinstance(result, SynthesisResult):
            raise TypeError("synthesis provider returned an invalid result")
        response = normalize_response(
            SynthesisResponse.model_validate(result.response.model_dump())
        )
        snapshot_run_id = str(context.get("snapshotRunId") or "").strip()
        if not snapshot_run_id:
            raise ValueError("synthesis context requires snapshotRunId")
        ticker_value = str(context.get("ticker") or "").strip().upper()
        artifact_payload = SynthesisArtifact(
            analysis_id=definition.analysis_id,
            generated_at=result.generated_at,
            ticker=ticker_value or None,
            snapshot_run_id=snapshot_run_id,
            input_hash=input_hash,
            provider=result.provider,
            model=result.model,
            route=getattr(
                self.provider,
                "route_id",
                f"{result.provider}/{result.model}",
            ),
            adapter=getattr(self.provider, "adapter", "unknown"),
            provider_revision=getattr(self.provider, "provider_revision", None),
            route_policy_revision=getattr(
                self.provider,
                "route_policy_revision",
                None,
            ),
            prompt_version=definition.prompt_version,
            response=response,
            usage=result.usage.model_dump(mode="json"),
            latency_ms=result.latency_ms,
            fake=result.fake,
        )
        ticker_key = _safe_component(ticker_value or "portfolio")
        key = f"synthesis/{_safe_component(definition.analysis_id)}/{ticker_key}.json"
        return self.artifacts.put_json(
            key=key,
            payload=artifact_payload.model_dump(
                mode="json",
                by_alias=False,
                exclude={"page"},
            ),
            kind="llm_synthesis",
            as_of=snapshot_run_id,
            producer_version=f"{result.provider}:{definition.prompt_version}",
            dependency_artifact_ids=list(input_artifact_ids),
            quality=ArtifactQuality(
                status="verified",
                coverage=f"confidence={response.confidence:.2f}",
                warnings=[],
            ),
        )


__all__ = ["SynthesisArtifact", "SynthesisService"]
