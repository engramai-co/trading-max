"""Typed event-time cash-flow evidence shared by NAV production and the API."""

from datetime import date, datetime

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
