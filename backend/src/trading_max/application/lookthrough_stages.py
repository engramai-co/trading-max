"""Durable portfolio look-through stage."""

from __future__ import annotations

from pathlib import Path

from trading_max.analytics.lookthrough import LookthroughService
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    OfficialFundHoldingsProvider,
)
from trading_max.reference import CatalogSecurityMaster, SecurityMasterCatalog

from .errors import StageExecutionError
from .stages import StageContext, StageResult


def _account_artifact(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    profile: str,
) -> tuple[dict, str] | None:
    key = f"account/{profile}.json"
    for artifact_id in context.upstream_artifact_ids:
        try:
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == key:
            return stored.payload, stored.ref.artifact_id
    return None


def _security_master_artifact(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
) -> tuple[SecurityMasterCatalog, str] | None:
    for artifact_id in context.upstream_artifact_ids:
        try:
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == "reference/security_master.json":
            return (
                SecurityMasterCatalog.model_validate(stored.payload),
                stored.ref.artifact_id,
            )
    return None


class PortfolioLookthroughStage:
    """Publish direct and ETF-underlying exposure with explicit coverage."""

    name = "portfolio.lookthrough"
    version = "lookthrough-v8"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot", "reference.security_master")

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        service: LookthroughService | None = None,
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.service = service

    def run(self, context: StageContext) -> StageResult:
        accounts: dict[str, dict] = {}
        dependency_ids: list[str] = []
        for profile in ("invest", "isa"):
            stored = _account_artifact(self.artifacts, context, profile)
            if stored is None:
                raise StageExecutionError(
                    "portfolio.lookthrough_dependency_missing",
                    f"missing account snapshot artifact for {profile}",
                )
            payload, artifact_id = stored
            accounts[profile] = payload
            dependency_ids.append(artifact_id)
        security_master_artifact = _security_master_artifact(
            self.artifacts,
            context,
        )
        if security_master_artifact is not None:
            catalog, artifact_id = security_master_artifact
            dependency_ids.append(artifact_id)
            security_master = CatalogSecurityMaster(catalog)
        elif self.service is None:
            raise StageExecutionError(
                "portfolio.lookthrough_dependency_missing",
                "missing immutable security-master artifact",
            )
        else:
            security_master = None
        try:
            service = self.service or LookthroughService(
                OfficialFundHoldingsProvider(self.state_root),
                security_master,
            )
            payload = service.run(accounts)
        except Exception as exc:
            raise StageExecutionError(
                "portfolio.lookthrough_failed",
                str(exc),
                retryable=True,
            ) from exc
        warnings = [str(item) for item in payload.get("warnings", [])]
        artifact = self.artifacts.put_json(
            key="account/lookthrough_metrics.json",
            payload=payload,
            kind="lookthrough",
            as_of=str(payload.get("brokerAsOf") or "") or None,
            producer_version=self.version,
            dependency_artifact_ids=dependency_ids,
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{payload.get('lookthroughCoveragePct', 0):.2%}",
                warnings=warnings,
            ),
        )
        return StageResult(artifacts=(artifact.ref,), warnings=tuple(warnings))


__all__ = ["PortfolioLookthroughStage"]
