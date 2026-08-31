"""Account snapshot metrics extracted from the broker boundary."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from trading_max.domain import DomainModel
from trading_max.ingestion.brokers.trading212 import (
    BrokerPosition,
    BrokerSnapshot,
    default_data_root,
    snapshot_from_payload,
    validate_broker_snapshot,
)


class AccountPositionMetrics(DomainModel):
    """One normalized GBP account position for downstream analytics."""

    ticker: str
    broker_ticker: str
    name: str
    isin: str
    quantity: Decimal
    current_price: Decimal
    price_currency: str
    current_value_gbp: Decimal
    total_cost_gbp: Decimal
    unrealized_profit_loss_gbp: Decimal
    fx_impact_gbp: Decimal | None = None


class AccountSnapshotMetrics(DomainModel):
    """Validated account-level metrics with explicit currency fields."""

    profile: str
    fetched_at: datetime
    source: str | None = None
    total_value_gbp: Decimal
    cash_gbp: Decimal
    investments_value_gbp: Decimal
    position_value_gbp: Decimal
    total_cost_gbp: Decimal
    realized_profit_loss_gbp: Decimal
    unrealized_profit_loss_gbp: Decimal
    positions: list[AccountPositionMetrics]
    checks: dict[str, bool]


class IntradayAccountValue(DomainModel):
    """Broker-summary value observation with reconciliation-gated positions."""

    schema_version: int = 1
    profile: str
    fetched_at: datetime
    source: str | None = None
    value_source: Literal["broker_account_summary"] = "broker_account_summary"
    total_value_gbp: Decimal
    cash_gbp: Decimal
    investments_value_gbp: Decimal
    position_value_gbp: Decimal
    position_delta_gbp: Decimal
    position_tolerance_gbp: Decimal
    positions_status: Literal["verified", "unreconciled"]
    positions: list[AccountPositionMetrics] | None = None
    checks: dict[str, bool]


def display_ticker(ticker: str) -> str:
    """Convert the broker listing suffix into a canonical display ticker."""

    if ticker.endswith("_US_EQ"):
        return ticker.removesuffix("_US_EQ")
    if ticker.endswith("l_EQ"):
        return ticker.removesuffix("l_EQ").upper()
    return ticker


def _position_metrics(position: BrokerPosition) -> AccountPositionMetrics:
    return AccountPositionMetrics(
        ticker=display_ticker(position.broker_ticker or position.ticker),
        broker_ticker=position.broker_ticker,
        name=position.name,
        isin=position.isin,
        quantity=position.quantity,
        current_price=position.current_price,
        price_currency=position.price_currency,
        current_value_gbp=position.current_value_gbp,
        total_cost_gbp=position.total_cost_gbp,
        unrealized_profit_loss_gbp=position.unrealized_profit_loss_gbp,
        fx_impact_gbp=position.fx_impact_gbp,
    )


def account_snapshot_metrics(
    profile: str,
    snapshot: BrokerSnapshot | Mapping[str, Any],
    *,
    source: str | Path | None = None,
    require_positions_match: bool = True,
) -> AccountSnapshotMetrics:
    """Build typed metrics from a validated native broker snapshot.

    A raw mapping is validated by the broker adapter first. This keeps the
    account analytics layer from silently accepting partial or non-GBP data.
    """

    normalized = (
        snapshot
        if isinstance(snapshot, BrokerSnapshot)
        else snapshot_from_payload(
            profile,
            "live",
            snapshot,
            require_positions_match=require_positions_match,
        )
    )
    reconciliation = validate_broker_snapshot(
        normalized,
        require_positions_match=require_positions_match,
    )
    checks = {
        "positions_match_investments": reconciliation.positions_match_investments,
        "cash_plus_investments_matches_total": (reconciliation.cash_plus_investments_matches_total),
    }
    return AccountSnapshotMetrics(
        profile=profile,
        fetched_at=normalized.fetched_at,
        source=str(source) if source is not None else None,
        total_value_gbp=normalized.account.total_value,
        cash_gbp=normalized.account.cash_available,
        investments_value_gbp=normalized.account.investments_value,
        position_value_gbp=reconciliation.position_value_gbp.quantize(Decimal("0.01")),
        total_cost_gbp=normalized.account.investments_cost,
        realized_profit_loss_gbp=normalized.account.realized_profit_loss,
        unrealized_profit_loss_gbp=normalized.account.unrealized_profit_loss,
        positions=[_position_metrics(position) for position in normalized.positions],
        checks=checks,
    )


def intraday_account_value(metrics: AccountSnapshotMetrics) -> IntradayAccountValue:
    """Reduce a live snapshot to the fields required by the NAV anchor stage."""

    position_delta = metrics.position_value_gbp - metrics.investments_value_gbp
    position_tolerance = max(
        Decimal("0.02"),
        abs(metrics.investments_value_gbp) * Decimal("0.0005"),
    )
    positions_match = metrics.checks.get("positions_match_investments", False)
    return IntradayAccountValue(
        profile=metrics.profile,
        fetched_at=metrics.fetched_at,
        source=metrics.source,
        total_value_gbp=metrics.total_value_gbp,
        cash_gbp=metrics.cash_gbp,
        investments_value_gbp=metrics.investments_value_gbp,
        position_value_gbp=metrics.position_value_gbp,
        position_delta_gbp=position_delta,
        position_tolerance_gbp=position_tolerance,
        positions_status="verified" if positions_match else "unreconciled",
        positions=metrics.positions if positions_match else None,
        checks=metrics.checks,
    )


def latest_snapshot_path(
    profile: str,
    *,
    data_root: Path | None = None,
) -> Path:
    """Find the latest private broker snapshot without scanning Git outputs."""

    root = (data_root or default_data_root()).expanduser().resolve()
    snapshots = sorted((root / profile / "snapshots").glob("snapshot_*.json"))
    if not snapshots:
        raise FileNotFoundError(f"no Trading 212 snapshot found for {profile}")
    return snapshots[-1]


def metrics_from_snapshot_file(
    profile: str,
    path: Path,
    *,
    require_positions_match: bool = True,
) -> AccountSnapshotMetrics:
    """Load one private snapshot for a worker stage or a characterization test."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"broker snapshot is not an object: {path}")
    return account_snapshot_metrics(
        profile,
        payload,
        source=path,
        require_positions_match=require_positions_match,
    )


__all__ = [
    "AccountPositionMetrics",
    "AccountSnapshotMetrics",
    "IntradayAccountValue",
    "account_snapshot_metrics",
    "display_ticker",
    "intraday_account_value",
    "latest_snapshot_path",
    "metrics_from_snapshot_file",
]
