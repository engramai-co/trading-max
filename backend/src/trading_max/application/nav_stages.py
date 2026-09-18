"""Durable account NAV stage."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime
from pathlib import Path

from trading_max.analytics.cash_flow_history import AccountCashFlowHistory, account_state_digest
from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    HistoryLoader,
    reconstruct_historical_nav,
)
from trading_max.analytics.intraday import (
    IntradayAnchor,
    append_intraday_anchor,
    floor_bucket,
    merge_valuation_history,
)
from trading_max.analytics.intraday_reconstruction import (
    CachedIntradayPriceLoader,
    IntradayPriceLoader,
    reconstruct_intraday_account,
)
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
from .live_cash_flows import ledger_digest, live_cash_flow_refs
from .stages import StageContext, StageResult


def _upstream_json(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    key: str,
):
    for artifact_id in context.upstream_artifact_ids:
        try:
            ref = artifacts.get_ref(artifact_id)
        except FileNotFoundError:
            continue
        if ref.key == key:
            return artifacts.get_json(artifact_id)
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
    version = "nav-v5"
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
            flow_key = f"account/nav/cash_flows_{code.lower()}.json"
            previous_flows = _previous_json(self.artifacts, self.snapshots, flow_key)
            ledger_source = self._historical_export(profile)
            cash_source = self._cash_transactions(profile)
            source_digest = ledger_digest((ledger_source, cash_source))
            state_digest = account_state_digest(account.payload)
            prior_flows = (
                AccountCashFlowHistory.model_validate(previous_flows.payload)
                if previous_flows is not None
                else None
            )
            current_time = datetime.fromisoformat(
                str(account.payload["fetched_at"]).replace("Z", "+00:00")
            )
            flow_coverage_current = (
                prior_flows is not None
                and prior_flows.verified
                and prior_flows.source_digest == source_digest
                and current_time >= prior_flows.covered_until
                and prior_flows.account_state_digest == state_digest
            )
            # A legacy value-only ledger is not evidence that its dated cash
            # history can be replayed. Preserve that established append path;
            # only extend already eligible reconstructions between upgrades.
            can_extend_flows = previous is not None and any(
                row.get("PerformanceStatus") == "eligible"
                for row in csv.DictReader(io.StringIO(previous.path.read_text(encoding="utf-8")))
            )
            reconstruction = None
            try:
                fetched_at = datetime.fromisoformat(
                    str(account.payload["fetched_at"]).replace("Z", "+00:00")
                ).astimezone(UTC)
                export_path = (
                    ledger_source
                    if is_initial_baseline or (can_extend_flows and not flow_coverage_current)
                    else None
                )
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
            flow_history = reconstruction.cash_flows if reconstruction is not None else prior_flows
            # Mark-only refreshes use the same reconciled ledger and unchanged
            # cash/quantities. Reuse that evidence without re-fetching all prices.
            if flow_history is not None and (reconstruction is not None or flow_coverage_current):
                flows = self.artifacts.put_json(
                    key=flow_key,
                    payload=flow_history.model_copy(
                        update={
                            "source_digest": source_digest,
                            "account_state_digest": state_digest,
                            "covered_until": fetched_at,
                        }
                    ).model_dump(mode="json", by_alias=False),
                    kind="account_cash_flows",
                    as_of=fetched_at.isoformat(),
                    producer_version=self.version,
                    dependency_artifact_ids=[stored.ref.artifact_id],
                    quality=ArtifactQuality(
                        status="verified" if flow_history.verified else "warning",
                        coverage="dated external cash flows using the daily ledger's GBP amounts",
                        warnings=quality_warnings if not flow_history.verified else [],
                    ),
                )
                refs.append(flows.ref)
            elif previous_flows is not None:
                refs.append(previous_flows.ref)
        return StageResult(artifacts=tuple(refs), warnings=tuple(warnings))


class AccountIntradayNavStage:
    """Publish one valuation history for both broker collection and backfilling."""

    name = "accounts.intraday_nav"
    version = "valuation-history-v6"
    required_for = frozenset({"intraday", "accounts", "all"})
    dependencies = ("accounts.snapshot",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
        *,
        interval_seconds: int = 600,
        retention_days: int = 120,
        state_root: Path | None = None,
        history_loader: IntradayPriceLoader | None = None,
        history_loader_factory=None,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots
        self.interval_seconds = interval_seconds
        self.retention_days = retention_days
        self.state_root = state_root
        self.history_loader = history_loader
        self.history_loader_factory = history_loader_factory

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
            "account/nav/valuation_history.json",
        ) or _previous_json(
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
        warnings = [warning]
        market_data = {}
        if context.scope != "intraday" and self.state_root is not None:
            loader = self.history_loader or (
                self.history_loader_factory()
                if self.history_loader_factory
                else CachedIntradayPriceLoader(self.state_root / "cache" / "nav-prices")
            )
            modeled = {}
            for code, profile in (("A", "invest"), ("B", "isa")):
                try:
                    export = latest_export_path(profile, data_root=self.state_root / "trading212")
                    if export is None:
                        continue
                    modeled[code] = reconstruct_intraday_account(
                        export_path=export,
                        account=accounts[code],
                        history_loader=loader,
                        cash_transactions_path=latest_cash_transactions_path(
                            profile,
                            data_root=self.state_root / "trading212",
                        ),
                        retention_days=self.retention_days,
                    )
                except Exception as exc:
                    warnings.append(f"{profile} intraday reconstruction unavailable: {exc}")
            market_data = getattr(loader, "diagnostics", {})
            fallbacks = [
                key for key, value in market_data.items() if value.get("status") == "fallback"
            ]
            if fallbacks:
                warnings.append("Alpaca fallback: " + ", ".join(sorted(fallbacks)))
            if "A" in modeled and "B" in modeled:
                a, b = modeled["A"], modeled["B"]
                points = []
                for stamp in a.index.intersection(b.index):
                    invest, isa = a.loc[stamp], b.loc[stamp]
                    points.append(
                        IntradayAnchor(
                            observed_at=stamp.to_pydatetime(),
                            bucket_at=floor_bucket(stamp.to_pydatetime(), self.interval_seconds),
                            invest_value_gbp=float(invest.value),
                            isa_value_gbp=float(isa.value),
                            total_value_gbp=float(invest.value + isa.value),
                            invest_cash_gbp=float(invest.cash),
                            isa_cash_gbp=float(isa.cash),
                            source="reconstructed",
                            includes_extended_hours=True,
                            cadence_seconds=int(max(invest.cadence, isa.cadence)),
                            price_cadence_seconds=int(max(invest.price_cadence, isa.price_cadence)),
                            source_artifact_ids=dependencies[:2],
                        )
                    )
                series = merge_valuation_history(
                    series,
                    points,
                    generated_at=series.generated_at,
                    interval_seconds=self.interval_seconds,
                    retention_days=self.retention_days,
                    replace_reconstructed=True,
                )
                if not points:
                    warnings.append(
                        "no overlapping intraday market coverage; broker observations retained"
                    )
        stored = self.artifacts.put_json(
            key="account/nav/valuation_history.json",
            payload=series.model_dump(mode="json", by_alias=False),
            kind="intraday_nav",
            as_of=(series.points[-1].observed_at.isoformat() if series.points else None),
            producer_version=self.version,
            dependency_artifact_ids=dependencies,
            quality=ArtifactQuality(
                status="warning",
                coverage=f"{self.retention_days}-day unified observed and reconstructed valuations",
                warnings=warnings,
            ),
        )
        market_refs = []
        if context.scope != "intraday":
            market_refs.append(
                self.artifacts.put_json(
                    key="account/nav/market_data.json",
                    kind="market_data_provenance",
                    producer_version=self.version,
                    payload={
                        "generated_at": series.generated_at.isoformat(),
                        "baseline": "yahoo",
                        "enhancement": "alpaca" if market_data else None,
                        "feeds": market_data,
                    },
                    dependency_artifact_ids=dependencies,
                ).ref
            )
        # Full refreshes publish newly reconciled flows in AccountNavStage.
        # Only live collection may reuse the previous snapshot's evidence.
        flow_refs = (
            live_cash_flow_refs(
                self.artifacts,
                self.snapshots,
                self.state_root,
                accounts,
                dependencies[:2],
                self.version,
            )
            if context.scope == "intraday"
            else []
        )
        return StageResult(
            artifacts=(stored.ref, *market_refs, *flow_refs),
            warnings=tuple(warnings),
            metadata={
                "market_data": market_data,
                "anchor_count": len(series.points),
                "flow_unverified_count": sum(
                    point.flow_status != "verified" for point in series.points
                ),
            },
        )


__all__ = ["AccountIntradayNavStage", "AccountNavStage"]
