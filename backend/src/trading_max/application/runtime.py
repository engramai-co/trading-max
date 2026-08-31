"""Factories for the typed worker stage registry."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path

from trading_max.analytics.lookthrough import LookthroughService
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
    StoredSnapshot,
)
from trading_max.research.fundamentals import YFinanceResearchService
from trading_max.research.market import MarketResearchService

from .account_review_stages import AccountReviewStage
from .account_stages import (
    AccountCapitalRecoveryStage,
    AccountDilutedCostStage,
    AccountPolicyStage,
    AccountSnapshotStage,
)
from .broker_stages import BrokerSyncStage
from .cfd_stages import CfdAccountStage
from .lookthrough_stages import PortfolioLookthroughStage
from .nav_stages import AccountIntradayNavStage, AccountNavStage
from .performance_stages import AccountPerformanceStage
from .reference_stages import SecurityMasterEnrichmentStage
from .research_stages import (
    AdrArtifactStage,
    AnalystArtifactStage,
    EarningsArtifactStage,
    FinancialsArtifactStage,
    FundamentalsArtifactStage,
    MarketSnapshotStage,
    OptionsArtifactStage,
    TechnicalArtifactStage,
    TypedPublishSnapshotStage,
    ValuationArtifactStage,
)
from .stages import StageRegistry
from .taxonomy_stages import RawTaxonomyCatalogProvider, TaxonomyArtifactStage


class TypedWorkerRuntime:
    """Build a process-local registry with no shell or filesystem discovery."""

    def __init__(
        self,
        state_root: Path,
        *,
        on_snapshot_published: Callable[[StoredSnapshot, str], None] | None = None,
        market_service: MarketResearchService | None = None,
        research_service: YFinanceResearchService | None = None,
        lookthrough_service: LookthroughService | None = None,
        taxonomy_provider: RawTaxonomyCatalogProvider | None = None,
        valuation_assumptions=None,
        intraday_interval_seconds: int = 600,
        intraday_retention_days: int = 40,
        extra_stages: Iterable[object] = (),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.on_snapshot_published = on_snapshot_published
        self.market_service = market_service or MarketResearchService()
        self.research_service = research_service or YFinanceResearchService()
        self.lookthrough_service = lookthrough_service
        self.taxonomy_provider = taxonomy_provider or RawTaxonomyCatalogProvider(self.state_root)
        self.valuation_assumptions = valuation_assumptions
        self.intraday_interval_seconds = intraday_interval_seconds
        self.intraday_retention_days = intraday_retention_days
        self.extra_stages = tuple(extra_stages)
        self.artifacts = ContentAddressedArtifactStore(self.state_root / "artifacts")
        self.snapshots = SnapshotStore(self.state_root)

    def registry(self) -> StageRegistry:
        return StageRegistry(
            [
                BrokerSyncStage(self.state_root, self.artifacts),
                AccountSnapshotStage(self.state_root, self.artifacts),
                AccountIntradayNavStage(
                    self.artifacts,
                    self.snapshots,
                    interval_seconds=self.intraday_interval_seconds,
                    retention_days=self.intraday_retention_days,
                ),
                SecurityMasterEnrichmentStage(self.state_root, self.artifacts),
                PortfolioLookthroughStage(
                    self.state_root,
                    self.artifacts,
                    self.lookthrough_service,
                ),
                AccountDilutedCostStage(self.state_root, self.artifacts),
                AccountPolicyStage(self.state_root, self.artifacts),
                AccountCapitalRecoveryStage(self.state_root, self.artifacts),
                AccountNavStage(
                    self.artifacts,
                    self.snapshots,
                    self.state_root,
                ),
                CfdAccountStage(self.state_root, self.artifacts),
                AccountPerformanceStage(self.artifacts, self.snapshots),
                AccountReviewStage(self.state_root, self.artifacts),
                MarketSnapshotStage(self.artifacts, self.market_service),
                TaxonomyArtifactStage(self.artifacts, self.taxonomy_provider),
                TechnicalArtifactStage(self.artifacts),
                OptionsArtifactStage(self.artifacts),
                AdrArtifactStage(self.artifacts),
                FundamentalsArtifactStage(self.artifacts, self.research_service),
                FinancialsArtifactStage(self.artifacts, self.research_service),
                AnalystArtifactStage(self.artifacts, self.research_service),
                ValuationArtifactStage(
                    self.artifacts,
                    self.snapshots,
                    fx_loader=self.research_service.fx_loader,
                    assumptions_store=self.valuation_assumptions,
                ),
                EarningsArtifactStage(self.artifacts, self.research_service),
                TypedPublishSnapshotStage(
                    self.artifacts,
                    self.snapshots,
                    self.on_snapshot_published,
                ),
                *self.extra_stages,
            ]
        )


__all__ = ["TypedWorkerRuntime"]
