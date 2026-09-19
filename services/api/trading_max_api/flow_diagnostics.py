"""Read current immutable valuation coverage without changing portfolio calculations."""

from __future__ import annotations

import threading

from trading_max.analytics.intraday import IntradayAnchorSeries
from trading_max.infrastructure import ArtifactIntegrityError

from .artifacts import ArtifactStore
from .models import SnapshotFlowVerification, SnapshotManifest
from .portfolio_cashflows import CashFlowTimeline


class SnapshotFlowDiagnostics:
    """Share one snapshot-level coverage read across the live/performance schedules."""

    def __init__(self, store: ArtifactStore) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._cached: SnapshotFlowVerification | None = None

    def status(self) -> SnapshotFlowVerification:
        with self._lock:
            try:
                manifest = self.store.latest_manifest()
            except (OSError, TypeError, ValueError, ArtifactIntegrityError):
                return SnapshotFlowVerification()
            if manifest is None:
                # ArtifactStore also returns None for an invalid latest pointer.
                # Only an absent pointer means this installation has no snapshot.
                try:
                    self.store.immutable_snapshots.latest_path.stat()
                except FileNotFoundError:
                    return SnapshotFlowVerification(flow_verification_status="no_snapshot")
                except OSError:
                    pass
                return SnapshotFlowVerification()
            if self._cached is not None and self._cached.flow_snapshot_run_id == manifest.run_id:
                return self._cached.model_copy()
            result = self._read(manifest)
            # Cache only a successful immutable read. Missing/corrupt files may
            # be restored without changing the manifest, so retry those reads.
            if result.flow_verification_status == "available":
                self._cached = result
            return result

    def _read(self, manifest: SnapshotManifest) -> SnapshotFlowVerification:
        unavailable = SnapshotFlowVerification(flow_snapshot_run_id=manifest.run_id)
        keys = {artifact.key for artifact in manifest.artifacts}
        key = next(
            (
                candidate
                for candidate in (
                    "account/nav/valuation_history.json",
                    "account/nav/intraday_anchors.json",
                )
                if candidate in keys
            ),
            None,
        )
        if key is None:
            return unavailable
        try:
            series = IntradayAnchorSeries.model_validate(self.store.read_json(manifest.run_id, key))
            flows = []
            for code in ("a", "b"):
                flow_key = f"account/nav/cash_flows_{code}.json"
                payload = (
                    self.store.read_json(manifest.run_id, flow_key) if flow_key in keys else None
                )
                flows.append(CashFlowTimeline(payload))
        except (OSError, TypeError, ValueError, ArtifactIntegrityError):
            return unavailable
        # Match the dashboard's effective flowStatus: newer reconciled flow
        # artifacts can verify an older raw anchor that still says unverified.
        unverified = sum(
            point.flow_status != "verified"
            and (
                flows[0].at(point.invest_observed_at or point.observed_at) is None
                or flows[1].at(point.isa_observed_at or point.observed_at) is None
            )
            for point in series.points
        )
        return SnapshotFlowVerification(
            flow_verification_status="available",
            flow_snapshot_run_id=manifest.run_id,
            flow_anchor_count=len(series.points),
            flow_unverified_count=unverified,
        )
