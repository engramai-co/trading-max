"""Durable reference-data enrichment before portfolio look-through."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    OfficialFundHoldingsProvider,
)
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityDescriptor,
    is_fund_instrument,
)
from trading_max.reference.enrichment import (
    EnrichmentCandidate,
    SecurityMasterEnricher,
)

from .errors import StageExecutionError
from .stages import StageContext, StageResult


def _number(value: Any) -> float:
    try:
        return max(float(value), 0.0)
    except (TypeError, ValueError):
        return 0.0


def _account_payloads(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    accounts: dict[str, dict[str, Any]] = {}
    dependencies: list[str] = []
    for artifact_id in context.upstream_artifact_ids:
        try:
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        for profile in ("invest", "isa"):
            if stored.ref.key == f"account/{profile}.json":
                accounts[profile] = stored.payload
                dependencies.append(stored.ref.artifact_id)
    if set(accounts) != {"invest", "isa"}:
        raise StageExecutionError(
            "reference.security_master_dependency_missing",
            "missing Invest or ISA account snapshot artifact",
        )
    return accounts, dependencies


class SecurityMasterEnrichmentStage:
    """Resolve ETF constituents and classify business profiles dynamically."""

    name = "reference.security_master"
    version = "security-master-v8"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        *,
        enricher: SecurityMasterEnricher | None = None,
        fund_provider: OfficialFundHoldingsProvider | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.enricher = enricher or SecurityMasterEnricher(state_root)
        self.fund_provider = fund_provider or OfficialFundHoldingsProvider(state_root)

    def _account_candidates(
        self,
        accounts: Mapping[str, Mapping[str, Any]],
    ) -> list[EnrichmentCandidate]:
        candidates: list[EnrichmentCandidate] = []
        for profile in ("invest", "isa"):
            for position in accounts.get(profile, {}).get("positions", []):
                if not isinstance(position, Mapping):
                    continue
                ticker = str(position.get("ticker") or "").strip().upper()
                value = _number(position.get("current_value_gbp"))
                if value <= 0:
                    continue
                candidates.append(
                    EnrichmentCandidate(
                        security=SecurityDescriptor(
                            ticker=ticker,
                            name=str(position.get("name") or ticker),
                            exchange=str(position.get("exchange") or ""),
                            mic=str(position.get("mic") or ""),
                            isin=str(position.get("isin") or ""),
                        ),
                        exposure_gbp=value,
                        gics_eligibility_hint="pending",
                    )
                )
        return candidates

    def _economic_exposure_candidates(
        self,
        account_candidates: list[EnrichmentCandidate],
    ) -> tuple[list[EnrichmentCandidate], list[str]]:
        resolver = CatalogSecurityMaster.from_state_root(self.enricher.state_root)
        candidates: list[EnrichmentCandidate] = []
        warnings: list[str] = []
        for candidate in account_candidates:
            resolved = resolver.resolve(candidate.security)
            if not is_fund_instrument(
                quote_type=resolved.security_type,
                provider_security_type=resolved.provider_security_type,
                provider_security_type2=resolved.provider_security_type2,
            ):
                candidates.append(candidate)
                continue
            # Issuer data can resolve the same ISIN to another exchange listing.
            # Official holdings adapters are keyed by the broker-held listing.
            ticker = candidate.security.ticker or resolved.canonical_ticker
            try:
                snapshot = self.fund_provider.fetch(ticker)
            except Exception as exc:
                warnings.append(f"{ticker}: constituent fetch failed: {exc}")
                candidates.append(candidate)
                continue
            if snapshot is None:
                warnings.append(f"{ticker}: no fund-holdings adapter or snapshot is available")
                candidates.append(candidate)
                continue
            for holding in snapshot.holdings:
                if not holding.is_security:
                    continue
                candidates.append(
                    EnrichmentCandidate(
                        security=SecurityDescriptor(
                            ticker=holding.ticker,
                            name=holding.name,
                            isin=holding.isin,
                            figi=holding.figi,
                            composite_figi=holding.composite_figi,
                            share_class_figi=holding.share_class_figi,
                            country=holding.country,
                            industry=holding.industry,
                        ),
                        exposure_gbp=candidate.exposure_gbp * holding.weight_pct / 100,
                        gics_eligibility_hint=(
                            "eligible" if holding.is_equity else "not-applicable"
                        ),
                    )
                )
        return candidates, warnings

    def run(self, context: StageContext) -> StageResult:
        accounts, dependencies = _account_payloads(self.artifacts, context)
        account_candidates = self._account_candidates(accounts)
        warnings: list[str] = []
        try:
            # Phase 1 discovers security type and canonical identity for every
            # broker position. Phase 2 expands funds and classifies the actual
            # economic equity exposure, including ETF constituents.
            self.enricher.enrich(account_candidates, exhaustive=True)
            candidates, fund_warnings = self._economic_exposure_candidates(account_candidates)
            warnings.extend(fund_warnings)
            # Do not turn the target coverage threshold into a permanent
            # classification ceiling. The request budget protects the online
            # provider per run; cached progress lets later runs converge over
            # the full dynamically discovered equity universe.
            report = self.enricher.enrich(candidates, exhaustive=True)
        except Exception as exc:
            raise StageExecutionError(
                "reference.security_master_failed",
                str(exc),
                retryable=True,
            ) from exc
        if report.material_unclassified:
            warnings.append(
                f"{len(report.material_unclassified)} material equity exposures remain unclassified"
            )
        if report.material_unresolved:
            warnings.append(
                f"{len(report.material_unresolved)} material security identities remain unresolved"
            )
        if report.failures:
            warnings.append(f"{report.failed} security profile lookups failed")
        if report.deferred:
            warnings.append(
                f"{report.deferred} lower-exposure profiles were deferred by the "
                f"{report.request_budget}-request refresh budget"
            )
        if report.resolved_unclassified_exposure_gbp:
            warnings.append(
                "resolved provider profiles without a reliable GICS sub-industry "
                f"mapping: £{report.resolved_unclassified_exposure_gbp:,.2f}"
            )
        if report.unresolved_exposure_gbp:
            warnings.append(
                f"security profiles not yet resolved: £{report.unresolved_exposure_gbp:,.2f}"
            )
        if report.unexpanded_fund_exposure_gbp:
            warnings.append(
                "fund exposure without constituent expansion: "
                f"£{report.unexpanded_fund_exposure_gbp:,.2f}"
            )
        catalog = CatalogSecurityMaster.from_state_root(self.enricher.state_root).catalog
        catalog_artifact = self.artifacts.put_json(
            key="reference/security_master.json",
            payload=catalog.model_dump(mode="json", by_alias=True),
            kind="reference-data",
            as_of=catalog.as_of or report.generated_at.date().isoformat(),
            producer_version=self.version,
            dependency_artifact_ids=dependencies,
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{report.classification_coverage_pct:.2%}",
                warnings=warnings,
            ),
        )
        payload = report.model_dump(mode="json", by_alias=True)
        report_artifact = self.artifacts.put_json(
            key="reference/security_master_report.json",
            payload=payload,
            kind="reference-data",
            as_of=report.generated_at.date().isoformat(),
            producer_version=self.version,
            dependency_artifact_ids=(catalog_artifact.ref.artifact_id,),
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{report.classification_coverage_pct:.2%}",
                warnings=warnings,
            ),
        )
        return StageResult(
            artifacts=(catalog_artifact.ref, report_artifact.ref),
            warnings=tuple(warnings),
        )


__all__ = ["SecurityMasterEnrichmentStage"]
