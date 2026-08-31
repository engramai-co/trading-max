"""Durable account NAV stage."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime
from pathlib import Path

from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    HistoryLoader,
    reconstruct_historical_nav,
)
from trading_max.analytics.intraday import append_intraday_anchor
from trading_max.analytics.nav import append_valuation
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
)
from trading_max.ingestion.brokers.trading212 import (
    latest_cash_transactions_path,
    latest_export_path,
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
            stored = artifacts.get_json(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == key:
            return stored
    return None


def _previous_json(
    artifacts: ContentAddressedArtifactStore,
    snapshots: SnapshotStore,
    key: str,
):
    previous = snapshots.latest()
    if previous is None:
        return None
    ref = next(
        (item for item in previous.manifest.artifacts if item.key == key),
        None,
    )
    if ref is None:
        return None
    try:
        return artifacts.get_json(ref.artifact_id)
    except FileNotFoundError:
        return None


class AccountNavStage:
    """Backfill or append trusted, cash-flow-aware account NAV histories."""

    name = "accounts.nav"
    version = "nav-v4"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        state_root: Path | None = None,
        *,
        history_loader: HistoryLoader | None = None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.state_root = state_root.expanduser().resolve() if state_root is not None else None
        self.history_loader = history_loader

    def _historical_export(self, profile: str) -> Path | None:
        if self.state_root is None:
            return None
        return latest_export_path(
            profile,
            data_root=self.state_root / "trading212",
        )

    def _cash_transactions(self, profile: str) -> Path | None:
        if self.state_root is None:
            return None
        return latest_cash_transactions_path(
            profile,
            data_root=self.state_root / "trading212",
        )

    @classmethod
    def _needs_reconstruction(
        cls,
        previous: bytes | None,
        *,
        producer_version: str | None = None,
    ) -> bool:
        """Return whether a ledger still lacks an eligible reconstruction."""

        if previous is None:
            return True
        if (
            producer_version is not None
            and producer_version.startswith("nav-v")
            and producer_version != cls.version
        ):
            # A new NAV adapter version changes historical attribution, not
            # merely the latest point. Rebuild even an otherwise eligible old
            # ledger so corrected symbol/FX handling is actually published.
            return True
        try:
            rows = list(csv.DictReader(io.StringIO(previous.decode("utf-8-sig"))))
        except (UnicodeError, csv.Error):
            return False
        if not rows:
            return True
        if any(str(row.get("PerformanceStatus") or "") == "eligible" for row in rows):
            return False
        if any(
            str(row.get("ValuationSource") or "") == "synthetic_reconstruction"
            and str(row.get("PerformanceStatus") or "") == "missing_dated_cash_events"
            for row in rows
        ):
            # Retry reconstructions produced by an older adapter.  This is
            # required when a newer release learns how to reconcile an
            # omitted wallet event or settlement currency.
            return True
        return len(rows) == 1 and (
            not str(rows[0].get("DailyReturn") or "").strip()
            and not str(rows[0].get("TWRWealth") or "").strip()
        )

    def run(self, context: StageContext) -> StageResult:
        refs = []
        warnings: list[str] = []
        previous_snapshot = self.snapshots.latest()
        previous_refs = (
            {ref.key: ref for ref in previous_snapshot.manifest.artifacts}
            if previous_snapshot is not None
            else {}
        )
        nav_keys = {f"account/nav/daily_nav_{code.lower()}.csv" for code in ("A", "B")}
        has_existing_nav_ledger = any(key in previous_refs for key in nav_keys)
        for code, profile in (("A", "invest"), ("B", "isa")):
            key = f"account/nav/daily_nav_{code.lower()}.csv"
            account = _upstream_json(
                self.artifacts,
                context,
                f"account/{profile}.json",
            )
            if account is None:
                raise StageExecutionError(
                    "account.snapshot_dependency_missing",
                    f"missing current account artifact for {profile}",
                )

            previous_ref = previous_refs.get(key)
            try:
                previous = (
                    self.artifacts.get_bytes(previous_ref.artifact_id)
                    if previous_ref is not None
                    else None
                )
            except FileNotFoundError as exc:
                raise StageExecutionError(
                    "account.nav_missing",
                    f"trusted NAV artifact is missing for account {code}",
                ) from exc
            if previous is None and has_existing_nav_ledger:
                raise StageExecutionError(
                    "account.nav_missing",
                    f"trusted NAV ledger is incomplete for account {code}",
                )

            is_initial_baseline = self._needs_reconstruction(
                previous.path.read_bytes() if previous is not None else None,
                producer_version=(previous_ref.producer_version if previous_ref else None),
            )
            reconstruction = None
            try:
                fetched_at = datetime.fromisoformat(
                    str(account.payload["fetched_at"]).replace("Z", "+00:00")
                ).astimezone(UTC)
                export_path = self._historical_export(profile) if is_initial_baseline else None
                if export_path is not None:
                    kwargs = {"history_loader": self.history_loader} if self.history_loader else {}
                    reconstruction = reconstruct_historical_nav(
                        export_path=export_path,
                        account=account.payload,
                        cash_transactions_path=self._cash_transactions(profile),
                        **kwargs,
                    )
                    content = reconstruction.content
                else:
                    content = append_valuation(
                        previous.path.read_text(encoding="utf-8") if previous is not None else "",
                        date=fetched_at.date().isoformat(),
                        value=float(account.payload["total_value_gbp"]),
                        cash=float(account.payload.get("cash_gbp") or 0.0),
                        invested=float(account.payload.get("investments_value_gbp") or 0.0),
                    )
            except HistoricalNavError as exc:
                raise StageExecutionError(
                    "account.nav_reconstruction_failed",
                    f"account {code}: {exc}",
                ) from exc
            except (KeyError, TypeError, ValueError) as exc:
                raise StageExecutionError(
                    "account.nav_invalid",
                    f"account {code}: {exc}",
                ) from exc
            dependency_artifact_ids = [account.ref.artifact_id]
            if previous is not None:
                dependency_artifact_ids.append(previous.ref.artifact_id)
            baseline_warning = (
                f"account {code} NAV initialized from the current verified broker valuation; "
                "performance ratios require a later valuation date"
            )
            reconstruction_warning = (
                f"account {code} history is reconstructed from official broker cash flows and "
                "Yahoo-compatible closes; the latest point is broker-native"
            )
            cash_anchor_warning = (
                f"account {code} reconstructed cash differs from the broker by GBP "
                f"{abs(reconstruction.broker_anchor_cash_adjustment_gbp):.2f}; "
                "the broker-native terminal value is retained, but performance ratios "
                "are suppressed rather than inferred"
                if reconstruction is not None and not reconstruction.performance_eligible
                else None
            )
            warning = reconstruction_warning if reconstruction is not None else baseline_warning
            if is_initial_baseline and reconstruction is None:
                warnings.append(warning)
            if cash_anchor_warning is not None:
                warnings.append(cash_anchor_warning)
            quality_warnings = (
                [reconstruction_warning, cash_anchor_warning]
                if cash_anchor_warning is not None
                else [warning]
                if reconstruction is not None or is_initial_baseline
                else []
            )
            stored = self.artifacts.put_bytes(
                key=key,
                content=content,
                kind="nav_series",
                media_type="text/csv",
                as_of=fetched_at.date().isoformat(),
                producer_version=self.version,
                dependency_artifact_ids=dependency_artifact_ids,
                quality=ArtifactQuality(
                    status=(
                        "warning"
                        if (is_initial_baseline and reconstruction is None)
                        or cash_anchor_warning is not None
                        else "verified"
                    ),
                    coverage=(
                        f"{reconstruction.observations} reconstructed daily valuations; "
                        "terminal broker-native anchor; "
                        + (
                            "cash-flow-complete performance series"
                            if reconstruction.performance_eligible
                            else "performance unavailable because dated cash history is incomplete"
                        )
                        if reconstruction is not None
                        else "initial broker valuation baseline; no return interval yet"
                        if is_initial_baseline
                        else "broker valuation appended; external flow not inferred"
                    ),
                    warnings=quality_warnings,
                ),
            )
            refs.append(stored.ref)
        return StageResult(artifacts=tuple(refs), warnings=tuple(warnings))


class AccountIntradayNavStage:
    """Append one bounded broker-value anchor without changing daily NAV."""

    name = "accounts.intraday_nav"
    version = "intraday-nav-v1"
    required_for = frozenset({"intraday"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        *,
        interval_seconds: int = 600,
        retention_days: int = 40,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.interval_seconds = interval_seconds
        self.retention_days = retention_days

    def run(self, context: StageContext) -> StageResult:
        accounts: dict[str, dict] = {}
        dependencies: list[str] = []
        for profile in ("invest", "isa"):
            account = _upstream_json(
                self.artifacts,
                context,
                f"account/intraday/{profile}.json",
            ) or _upstream_json(
                self.artifacts,
                context,
                f"account/{profile}.json",
            )
            if account is None:
                raise StageExecutionError(
                    "account.snapshot_dependency_missing",
                    f"missing current account artifact for {profile}",
                )
            code = "A" if profile == "invest" else "B"
            accounts[code] = account.payload
            dependencies.append(account.ref.artifact_id)

        previous = _previous_json(
            self.artifacts,
            self.snapshots,
            "account/nav/intraday_anchors.json",
        )
        if previous is not None:
            dependencies.append(previous.ref.artifact_id)
        try:
            series = append_intraday_anchor(
                previous.payload if previous is not None else None,
                accounts,
                source_artifact_ids=dependencies[:2],
                interval_seconds=self.interval_seconds,
                retention_days=self.retention_days,
            )
        except (TypeError, ValueError) as exc:
            raise StageExecutionError(
                "account.intraday_nav_invalid",
                str(exc),
            ) from exc

        warning = (
            "live broker snapshots do not include verified cash-flow coverage; "
            "intraday value changes must not be labelled TWR"
        )
        stored = self.artifacts.put_json(
            key="account/nav/intraday_anchors.json",
            payload=series.model_dump(mode="json", by_alias=False),
            kind="intraday_nav",
            as_of=(series.points[-1].observed_at.isoformat() if series.points else None),
            producer_version=self.version,
            dependency_artifact_ids=dependencies,
            quality=ArtifactQuality(
                status="warning",
                coverage="14-day rolling broker-value anchors",
                warnings=[warning],
            ),
        )
        return StageResult(
            artifacts=(stored.ref,),
            warnings=(warning,),
            metadata={
                "anchor_count": len(series.points),
                "flow_unverified_count": sum(
                    point.flow_status != "verified" for point in series.points
                ),
            },
        )


__all__ = ["AccountIntradayNavStage", "AccountNavStage"]
