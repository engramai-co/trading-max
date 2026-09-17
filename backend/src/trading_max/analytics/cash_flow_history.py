"""Typed event-time cash-flow evidence shared by NAV production and the API."""

import hashlib
import json
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any

from trading_max.domain import DomainModel


class AccountCashFlow(DomainModel):
    occurred_at: datetime
    accounting_date: date
    amount_gbp: float


class AccountCashFlowHistory(DomainModel):
    """Event timing with the exact GBP amounts used by the daily NAV ledger."""

    covered_from: datetime
    covered_until: datetime
    verified: bool
    events: list[AccountCashFlow]
    source_digest: str = ""
    account_state_digest: str = ""


def account_state_digest(account: Mapping[str, Any]) -> str:
    """Fingerprint cash and quantities; market-price changes do not change flows."""
    return hashlib.sha256(
        json.dumps(
            {
                "cash": account.get("cash_gbp"),
                "positions": sorted(
                    (str(p.get("isin") or p.get("ticker")), p.get("quantity"))
                    for p in account.get("positions", [])
                ),
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


def extend_live_cash_flows(
    history: AccountCashFlowHistory,
    account: Mapping[str, Any],
    source_digest: str,
) -> AccountCashFlowHistory | None:
    """Reuse reconciled evidence only for an unchanged, verified account state.

    This is the same mark-only check used by the daily NAV producer, applied
    on every live publication. A deposit, trade, ledger update or unreconciled
    position snapshot must wait for normal ledger reconciliation instead.
    """
    if (
        not history.verified
        or not source_digest
        or source_digest != history.source_digest
        or account.get("positions_status") != "verified"
        or not isinstance(account.get("positions"), list)
        or account.get("cash_gbp") is None
        or not history.account_state_digest
        or account_state_digest(account) != history.account_state_digest
    ):
        return None
    observed = datetime.fromisoformat(str(account["fetched_at"]).replace("Z", "+00:00"))
    if observed.tzinfo is None or observed <= history.covered_until:
        return None
    return history.model_copy(update={"covered_until": observed})
