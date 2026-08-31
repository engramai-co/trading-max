"""Durable Trading 212 ingestion stage."""

from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from trading_max.application.broker_sync import (
    BrokerSyncRequest,
    Trading212BrokerSync,
)
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.ingestion.brokers.trading212 import (
    broker_snapshot_reconciliation,
    snapshot_from_payload,
)

from .errors import StageExecutionError
from .stages import StageContext, StageResult


class BrokerSyncStage:
    """Fetch read-only broker data and persist its typed raw boundary."""

    name = "broker.sync"
    version = "broker-sync-v3"
    required_for = frozenset({"all", "accounts", "intraday"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        state_root: Path,
        artifacts: ContentAddressedArtifactStore,
        *,
        sync: Trading212BrokerSync | None = None,
        profiles: tuple[str, ...] = ("invest", "isa"),
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.artifacts = artifacts
        self.profiles = profiles
        self.sync = sync or Trading212BrokerSync(
            store_factory=lambda profile: self._store(profile),
        )

    def _store(self, profile: str):
        from trading_max.ingestion.brokers.trading212 import ManagedAccountStore

        return ManagedAccountStore(
            profile,
            data_root=self.state_root / "trading212",
        )

    @staticmethod
    def _window(*, now: datetime | None = None) -> tuple[date, date]:
        # Trading 212 export intervals are UTC. Around local midnight in a
        # timezone ahead of UTC, date.today() can already be tomorrow while the
        # broker still considers that end date to be in the future.
        today = (now or datetime.now(UTC)).astimezone(UTC).date()
        configured = os.environ.get("TRADING_MAX_BROKER_EXPORT_START", "")
        if configured:
            start = date.fromisoformat(configured)
        else:
            lookback_days = int(os.environ.get("TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS", "365"))
            if not 1 <= lookback_days <= 365:
                raise ValueError(
                    "TRADING_MAX_BROKER_EXPORT_LOOKBACK_DAYS must be between 1 and 365"
                )
            start = today - timedelta(days=lookback_days)
        return start, today

    def run(self, context: StageContext) -> StageResult:
        if context.trigger == "intraday":
            return self._run_intraday()
        start, end = self._window()
        refs = []
        warnings: list[str] = []
        for profile in self.profiles:
            request = BrokerSyncRequest(
                profile=profile,
                environment=os.environ.get("T212_ENVIRONMENT", "live"),
                export_start=start,
                export_end=end,
                include_pending_orders=False,
                strict_reconcile=os.environ.get(
                    "TRADING_MAX_STRICT_BROKER_RECONCILIATION", "true"
                ).lower()
                in {"1", "true", "yes", "on"},
                coverage=os.environ.get("TRADING_MAX_BROKER_RECONCILIATION_COVERAGE", "complete"),
                coverage_note=os.environ.get("TRADING_MAX_BROKER_RECONCILIATION_COVERAGE_NOTE", ""),
                history_floor=date.fromisoformat(
                    os.environ.get("TRADING_MAX_BROKER_EXPORT_FLOOR", "2016-01-01")
                ),
            )
            try:
                result = self.sync.sync(request)
            except Exception as exc:
                retryable = not isinstance(exc, ValueError)
                raise StageExecutionError(
                    "broker.sync_failed",
                    f"{profile}: {exc}",
                    retryable=retryable,
                ) from exc
            payload = result.snapshot.model_dump(mode="json", by_alias=False)
            artifact = self.artifacts.put_json(
                key=f"raw/trading212/{profile}.json",
                payload=payload,
                kind="broker_snapshot",
                as_of=result.snapshot.fetched_at.date().isoformat(),
                producer_version=self.version,
                quality=ArtifactQuality(
                    status="verified"
                    if result.reconciliation.status == "verified"
                    else "unverified",
                    coverage=result.reconciliation.status,
                    warnings=warnings,
                ),
            )
            refs.append(artifact.ref)

        return StageResult(artifacts=tuple(refs), warnings=tuple(warnings))

    def _run_intraday(self) -> StageResult:
        """Publish current broker values without requesting history exports."""

        refs = []
        base_warning = (
            "live broker snapshot has no verified cash-flow coverage; "
            "intraday returns remain unverified"
        )
        warnings = [base_warning]
        environment = os.environ.get("T212_ENVIRONMENT", "live")
        for profile in self.profiles:
            try:
                raw_snapshot = self.sync.snapshot_only(
                    profile,
                    environment=environment,
                    include_pending_orders=False,
                    allow_unreconciled_positions=True,
                    reconciliation_attempts=2,
                    reconciliation_retry_seconds=5.0,
                )
                snapshot = snapshot_from_payload(
                    profile,
                    environment,
                    raw_snapshot,
                    require_positions_match=False,
                )
            except Exception as exc:
                retryable = not isinstance(exc, ValueError)
                raise StageExecutionError(
                    "broker.intraday_snapshot_failed",
                    f"{profile}: {exc}",
                    retryable=retryable,
                ) from exc
            reconciliation = broker_snapshot_reconciliation(snapshot)
            profile_warnings = [base_warning]
            if not reconciliation.positions_match_investments:
                warning = (
                    f"{profile}: live position detail differs from the broker account summary "
                    f"by GBP {reconciliation.position_delta_gbp}; the intraday total remains "
                    "broker-summary authoritative and position-dependent analysis is unchanged"
                )
                warnings.append(warning)
                profile_warnings.append(warning)
            artifact = self.artifacts.put_json(
                key=f"raw/trading212/{profile}.json",
                payload=raw_snapshot,
                kind="broker_snapshot",
                as_of=snapshot.fetched_at.date().isoformat(),
                producer_version=self.version,
                quality=ArtifactQuality(
                    status="unverified",
                    coverage=(
                        "live_snapshot_only; positions_unreconciled"
                        if not reconciliation.positions_match_investments
                        else "live_snapshot_only"
                    ),
                    warnings=profile_warnings,
                ),
            )
            refs.append(artifact.ref)
        return StageResult(artifacts=tuple(refs), warnings=tuple(warnings))


__all__ = ["BrokerSyncStage"]
