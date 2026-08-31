"""Typed diluted-cost calculations for open campaigns."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from trading_max.domain import DomainModel


class DilutedCostMetrics(DomainModel):
    """Cash-recovery basis of one currently open campaign, in GBP."""

    diluted_cost_gbp: Decimal
    diluted_cost_per_share_gbp: Decimal | None
    net_buy_cash_out_gbp: Decimal
    recovered_cash_gbp: Decimal
    capital_recovery_ratio: Decimal | None


def _decimal(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value or 0))


def _campaign_value(campaign: Mapping[str, Any] | object, name: str) -> Decimal:
    if isinstance(campaign, Mapping):
        return _decimal(campaign.get(name))
    return _decimal(getattr(campaign, name))


def calculate_diluted_cost(
    campaign: Mapping[str, Any] | object,
    remaining_shares: Decimal | int | float | str,
) -> DilutedCostMetrics:
    """Calculate negative-capable diluted cost without float accumulation."""

    buy_cash_out = _campaign_value(campaign, "gross_buy_cash") + _campaign_value(
        campaign, "buy_fees"
    )
    sell_cash_in = _campaign_value(campaign, "gross_sell_cash") - _campaign_value(
        campaign, "sell_fees"
    )
    recovered_cash = sell_cash_in + _campaign_value(campaign, "distributions")
    diluted_cost = buy_cash_out - recovered_cash
    shares = _decimal(remaining_shares)
    per_share = diluted_cost / shares if shares > Decimal("1e-9") else None
    return DilutedCostMetrics(
        diluted_cost_gbp=diluted_cost,
        diluted_cost_per_share_gbp=per_share,
        net_buy_cash_out_gbp=buy_cash_out,
        recovered_cash_gbp=recovered_cash,
        capital_recovery_ratio=(recovered_cash / buy_cash_out if buy_cash_out else None),
    )


__all__ = ["DilutedCostMetrics", "calculate_diluted_cost"]
