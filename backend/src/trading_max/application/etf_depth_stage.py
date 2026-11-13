"""Publish ETF research depth outside the dashboard and broker paths."""

from datetime import UTC, datetime
from pathlib import Path

from trading_max.analytics.etf_details import etf_holdings_key
from trading_max.analytics.etf_peers import project_peers
from trading_max.analytics.etf_projection import ETF_SUMMARY_KEY, ETFPortfolio
from trading_max.analytics.lookthrough import FundSnapshot
from trading_max.domain.contracts import ArtifactRef
from trading_max.domain.etf_depth import ETF_PEERS_KEY, HMRC_REPORTING_KEY
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.infrastructure.fund_catalogs import FundCatalog
from trading_max.infrastructure.fund_downloads import isin
from trading_max.infrastructure.hmrc_reporting import HMRCReportingSource, reporting_fund

from .stages import StageContext, StageResult


class ETFDepthStage:
    """Reuse issuer files already in the workspace and the open HMRC register."""

    name = "research.etf_depth"
    version = "etf-depth-v1"
    required_for = frozenset({"all", "accounts", "research"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        root: Path,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        hmrc: HMRCReportingSource | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.cache = root / "raw" / "fund-holdings" / "v4"
        self.catalog = FundCatalog(root)
        self.hmrc = hmrc or HMRCReportingSource(root)

    def run(self, context: StageContext) -> StageResult:
        refs: dict[str, ArtifactRef] = {}
        if previous := self.snapshots.latest(verify_artifacts=False):
            refs.update({ref.key: ref for ref in previous.manifest.artifacts})
        current = [self.artifacts.get_ref(item) for item in context.upstream_artifact_ids]
        if any(ref.key == ETF_SUMMARY_KEY for ref in current):
            refs = {
                key: ref for key, ref in refs.items() if not key.startswith("account/etf_holdings/")
            }
        refs.update({ref.key: ref for ref in current})
        summary = refs.get(ETF_SUMMARY_KEY)
        if summary is None:
            return StageResult()

        portfolio = ETFPortfolio.model_validate(
            self.artifacts.get_json(summary.artifact_id).payload
        )
        profiles = {}
        input_ids = [summary.artifact_id]
        held = {identity for fund in portfolio.funds if (identity := isin(fund.isin))}
        candidates = self.catalog.cached_isins() if held else set()
        for identity in held:
            if ref := refs.get(etf_holdings_key(identity)):
                snapshot = FundSnapshot.model_validate(
                    self.artifacts.get_json(ref.artifact_id).payload
                )
                if (
                    snapshot.fund_isin == identity
                    and snapshot.profile
                    and snapshot.profile.isin == identity
                ):
                    profiles[identity] = snapshot.profile
                    input_ids.append(ref.artifact_id)
        # The catalogue establishes identity, never investment attributes. Read
        # only matching already cached profiles; do not fetch to fill the cohort.
        for path in self.cache.glob("*.json") if profiles else ():
            if path.stem not in candidates - held:
                continue
            try:
                snapshot = FundSnapshot.model_validate_json(path.read_bytes())
            except (ValueError, OSError):
                continue
            if (
                snapshot.fund_isin == path.stem
                and snapshot.profile
                and snapshot.profile.isin == path.stem
            ):
                profiles[path.stem] = snapshot.profile
        now = datetime.now(UTC)
        comparisons = project_peers(portfolio, profiles, candidates, now)
        output = [
            self.artifacts.put_json(
                key=ETF_PEERS_KEY,
                kind="etf-peer-comparisons",
                payload={key: value.model_dump(mode="json") for key, value in comparisons.items()},
                dependency_artifact_ids=input_ids,
                producer_version=self.version,
            ).ref
        ]
        try:
            register = self.hmrc.refresh(now) if held else None
        except OSError:
            register = None
        if register is not None or not held:
            results = {}
            for identity in held:
                if value := reporting_fund(register, identity, now.date()):
                    results[identity] = value.model_dump(mode="json")
            output.append(
                self.artifacts.put_json(
                    key=HMRC_REPORTING_KEY,
                    kind="etf-uk-reporting-funds",
                    as_of=register.publication_date.isoformat() if register else None,
                    payload=results,
                    dependency_artifact_ids=[summary.artifact_id],
                    producer_version=self.version,
                ).ref
            )
        return StageResult(artifacts=tuple(output))
