"""Typed account performance stages."""

from __future__ import annotations

import csv
import io
from bisect import bisect_right
from datetime import UTC, datetime
from itertools import pairwise
from typing import Any

from trading_max.analytics.performance import (
    PerformancePoint,
    calculate_performance,
)
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

from .errors import StageExecutionError
from .stages import StageContext, StageResult


def _previous_byte_artifact(
    artifacts: ContentAddressedArtifactStore,
    snapshots: SnapshotStore,
    key: str,
):
    previous = snapshots.latest()
    if previous is None:
        return None
    ref = next((item for item in previous.manifest.artifacts if item.key == key), None)
    if ref is None:
        return None
    try:
        return artifacts.get_bytes(ref.artifact_id)
    except FileNotFoundError:
        return None


def _previous_json_artifact(
    artifacts: ContentAddressedArtifactStore,
    snapshots: SnapshotStore,
    key: str,
):
    previous = snapshots.latest()
    if previous is None:
        return None
    ref = next((item for item in previous.manifest.artifacts if item.key == key), None)
    if ref is None:
        return None
    try:
        return artifacts.get_json(ref.artifact_id)
    except FileNotFoundError:
        return None


def _upstream_byte_artifact(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    key: str,
):
    for artifact_id in context.upstream_artifact_ids:
        try:
            stored = artifacts.get_bytes(artifact_id)
        except FileNotFoundError:
            continue
        if stored.ref.key == key:
            return stored
    return None


def _series(text: str) -> tuple[list[PerformancePoint], float]:
    rows = list(csv.DictReader(io.StringIO(text)))
    net_external_flows = sum(float(row.get("ExternalFlowGBP") or 0.0) for row in rows)
    wealth_rows = [(index, row) for index, row in enumerate(rows) if row.get("TWRWealth")]
    if wealth_rows:
        first_index = wealth_rows[0][0]
        baseline_row = rows[max(0, first_index - 1)]
        baseline_date = baseline_row.get("Date")
        result = (
            [
                PerformancePoint(
                    as_of=datetime.fromisoformat(str(baseline_date)[:10]).replace(tzinfo=UTC),
                    value=1.0,
                    external_flow=0.0,
                )
            ]
            if baseline_date and first_index > 0
            else []
        )
        for _, row in wealth_rows:
            date_text = row.get("Date")
            if not date_text:
                continue
            result.append(
                PerformancePoint(
                    as_of=datetime.fromisoformat(date_text[:10]).replace(tzinfo=UTC),
                    value=float(row["TWRWealth"]),
                    external_flow=0.0,
                )
            )
        return result, net_external_flows

    result = []
    for row in rows:
        value_text = row.get("SyntheticNAVGBP") or row.get("ValueGBP")
        date_text = row.get("Date")
        if not value_text or not date_text:
            continue
        value = float(value_text)
        if value <= 0:
            continue
        observed = datetime.fromisoformat(date_text[:10]).replace(tzinfo=UTC)
        result.append(
            PerformancePoint(
                as_of=observed,
                value=value,
                external_flow=float(row.get("ExternalFlowGBP") or 0.0),
            )
        )
    return result, net_external_flows


def _benchmark_returns(
    points: list[PerformancePoint],
    technical: dict[str, Any] | None,
    *,
    ticker: str = "VOO",
) -> list[float] | None:
    """Align a GBP-adjusted benchmark to the account valuation intervals."""

    if not technical or technical.get("benchmark_currency") != "GBP":
        return None
    if technical.get("benchmark_return_basis") != "auto_adjusted_close":
        return None
    raw_series = technical.get("benchmark_series")
    raw_points = raw_series.get(ticker) if isinstance(raw_series, dict) else None
    if not isinstance(raw_points, list):
        return None
    observations: list[tuple[datetime, float]] = []
    for item in raw_points:
        if not isinstance(item, dict):
            continue
        try:
            observed = datetime.fromisoformat(str(item.get("date"))[:10]).replace(tzinfo=UTC)
            close = float(item.get("close"))
        except (TypeError, ValueError):
            continue
        if close > 0:
            observations.append((observed, close))
    observations.sort(key=lambda item: item[0])
    if not observations or len(points) < 2:
        return None
    dates = [item[0] for item in observations]
    closes = [item[1] for item in observations]
    aligned: list[float] = []
    for point in points:
        index = bisect_right(dates, point.as_of) - 1
        if index < 0:
            return None
        aligned.append(closes[index])
    return [current / previous - 1.0 for previous, current in pairwise(aligned)]


def _payload(
    account: str,
    points: list[PerformancePoint],
    net_external_flows: float,
    benchmark_returns: list[float] | None = None,
) -> dict[str, Any]:
    metrics = calculate_performance(points, benchmark_returns=benchmark_returns)
    benchmark_total_return = None
    if benchmark_returns:
        wealth = 1.0
        for value in benchmark_returns:
            wealth *= 1.0 + value
        benchmark_total_return = wealth - 1.0
    return {
        "schema_version": 1,
        "account": account,
        "periods": metrics.periods,
        "twr_total_return": metrics.twr,
        "annualized_return": metrics.annualized_return,
        "annualized_volatility": metrics.volatility,
        "sharpe_sonia": metrics.sharpe,
        "sortino_sonia": metrics.sortino,
        "calmar_ratio": metrics.calmar,
        "information_ratio": metrics.information_ratio,
        "benchmark_ticker": "VOO" if benchmark_returns is not None else None,
        "benchmark_total_return": benchmark_total_return,
        "benchmark_currency": "GBP" if benchmark_returns is not None else None,
        "benchmark_return_basis": (
            "auto_adjusted_close" if benchmark_returns is not None else None
        ),
        "max_drawdown": metrics.max_drawdown,
        "current_drawdown": metrics.current_drawdown,
        "net_external_flows_gbp": net_external_flows,
        "nav_quality": "synthetic_market_nav",
    }


class AccountPerformanceStage:
    """Calculate TWR/risk metrics from immutable, cash-flow-aware NAV CSVs."""

    name = "accounts.performance"
    version = "performance-v2"
    required_for = frozenset({"all", "accounts"})
    dependencies = ("accounts.nav",)

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        snapshots: SnapshotStore,
    ) -> None:
        self.artifacts = artifacts
        self.snapshots = snapshots

    def run(self, context: StageContext) -> StageResult:
        refs = []
        metrics_by_account: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []
        technical = _previous_json_artifact(
            self.artifacts,
            self.snapshots,
            "research/technical.json",
        )
        technical_payload = technical.payload if technical is not None else None
        for account_code in ("A", "B"):
            key = f"account/nav/daily_nav_{account_code.lower()}.csv"
            current = _upstream_byte_artifact(self.artifacts, context, key)
            history = current or _previous_byte_artifact(
                self.artifacts,
                self.snapshots,
                key,
            )
            if history is None:
                raise StageExecutionError(
                    "account.nav_missing",
                    f"trusted NAV history is missing for account {account_code}",
                )
            points, net_external_flows = _series(history.path.read_text(encoding="utf-8"))
            if not points:
                raise StageExecutionError(
                    "account.nav_insufficient",
                    f"NAV history for account {account_code} has no valid valuation points",
                )
            has_return_interval = len(points) >= 2
            warning = (
                f"account {account_code} has only an initial NAV baseline; "
                "risk-adjusted performance requires a later valuation date"
            )
            if not has_return_interval:
                warnings.append(warning)
            try:
                benchmark_returns = _benchmark_returns(points, technical_payload)
                payload = _payload(
                    account_code,
                    points,
                    net_external_flows,
                    benchmark_returns,
                )
            except ValueError as exc:
                raise StageExecutionError(
                    "account.performance_invalid",
                    f"account {account_code}: {exc}",
                ) from exc
            stored = self.artifacts.put_json(
                key=f"account/performance_{account_code.lower()}.json",
                payload=payload,
                kind="performance",
                producer_version=self.version,
                dependency_artifact_ids=[
                    history.ref.artifact_id,
                    *(
                        [technical.ref.artifact_id]
                        if technical is not None and benchmark_returns is not None
                        else []
                    ),
                ],
                quality=ArtifactQuality(
                    status="verified" if has_return_interval else "warning",
                    coverage=f"{len(points)} NAV points",
                    warnings=[] if has_return_interval else [warning],
                ),
            )
            refs.append(stored.ref)
            metrics_by_account[account_code] = payload

        aggregate = self.artifacts.put_json(
            key="account/synthetic_nav_metrics.json",
            payload=metrics_by_account,
            kind="performance",
            producer_version=self.version,
            dependency_artifact_ids=[ref.artifact_id for ref in refs],
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage="2/2 accounts",
                warnings=warnings,
            ),
        )
        return StageResult(
            artifacts=(*refs, aggregate.ref),
            warnings=tuple(warnings),
        )


__all__ = ["AccountPerformanceStage"]
