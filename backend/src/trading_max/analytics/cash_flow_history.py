"""Typed event-time cash-flow evidence shared by NAV production and the API."""

import hashlib
import json
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from trading_max.domain import DomainModel

#: Broker cash movements that are capital entering or leaving the account.
EXTERNAL_CASH_TYPES = frozenset({"DEPOSIT", "TRANSFER", "WITHDRAW"})


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


def _positions(account: Mapping[str, Any]) -> list[tuple[str, Any]]:
    return sorted(
        (str(p.get("isin") or p.get("ticker")), p.get("quantity"))
        for p in account.get("positions", [])
    )


def account_state_digest(account: Mapping[str, Any]) -> str:
    """Fingerprint cash and quantities; market-price changes do not change flows."""
    return hashlib.sha256(
        json.dumps(
            {"cash": account.get("cash_gbp"), "positions": _positions(account)},
            sort_keys=True,
        ).encode()
    ).hexdigest()


def _instant(value: object) -> datetime | None:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return stamp.astimezone(UTC) if stamp.tzinfo is not None else None


def _pennies(value: object) -> int | None:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    pennies = amount * 100
    return int(pennies) if pennies == pennies.to_integral_value() else None


def _live_cash_only_events(
    history: AccountCashFlowHistory,
    account: Mapping[str, Any],
    observed: datetime,
    baselines: Iterable[Mapping[str, Any]],
    live_cash: Mapping[str, Any] | None,
) -> list[AccountCashFlow] | None:
    """Return deposits and withdrawals that alone explain a cash-only change.

    Every condition must hold, otherwise the change waits for the ledger:
    the quantities equal those of the last reconciled state; the broker's
    newest cash page was read after this value and reaches the ledger; each
    unledgered movement up to the observation is a whole-penny GBP deposit,
    withdrawal or transfer; and they sum exactly to the change in cash.
    Interest, fees, currency conversions and trades never qualify here.
    """

    if not isinstance(live_cash, Mapping) or live_cash.get("complete") is not True:
        return None
    fetched = _instant(live_cash.get("fetched_at"))
    items = live_cash.get("items")
    if fetched is None or fetched < observed or not isinstance(items, list):
        return None
    baseline = next(
        (
            candidate
            for candidate in baselines
            if isinstance(candidate, Mapping)
            and isinstance(candidate.get("positions"), list)
            and candidate.get("cash_gbp") is not None
            and account_state_digest(candidate) == history.account_state_digest
        ),
        None,
    )
    if baseline is None or _positions(baseline) != _positions(account):
        return None
    before, after = _pennies(baseline["cash_gbp"]), _pennies(account["cash_gbp"])
    if before is None or after is None:
        return None
    recorded = {
        (event.occurred_at.astimezone(UTC), round(event.amount_gbp * 100))
        for event in history.events
    }
    movements: list[tuple[datetime, int]] = []
    for item in items:
        if not isinstance(item, Mapping):
            return None
        occurred, pennies = _instant(item.get("dateTime")), _pennies(item.get("amount"))
        if occurred is None or pennies is None:
            return None
        if occurred > observed or (occurred, pennies) in recorded:
            # Later movements belong to the next value; recorded ones were
            # already added by an earlier live observation.
            continue
        if (
            occurred < history.covered_from
            or str(item.get("type") or "").strip().upper() not in EXTERNAL_CASH_TYPES
            or str(item.get("currency") or "").strip().upper() != "GBP"
        ):
            return None
        movements.append((occurred, pennies))
    if not movements or sum(pennies for _, pennies in movements) != after - before:
        return None
    return [
        AccountCashFlow(
            occurred_at=occurred,
            accounting_date=occurred.date(),
            amount_gbp=pennies / 100,
        )
        for occurred, pennies in sorted(movements)
    ]


def extend_live_cash_flows(
    history: AccountCashFlowHistory,
    account: Mapping[str, Any],
    source_digest: str,
    *,
    baselines: Iterable[Mapping[str, Any]] = (),
    live_cash: Mapping[str, Any] | None = None,
) -> AccountCashFlowHistory | None:
    """Extend reconciled evidence to a newer live value of the same account.

    An unchanged cash and quantity state reuses the evidence as the daily NAV
    producer does. A deposit or withdrawal that alone explains a cash-only
    change is added from the broker's newest cash movements (see
    :func:`_live_cash_only_events`). A trade, any other cash change, a ledger
    update or an unreconciled position snapshot waits for normal ledger
    reconciliation, which still follows and replaces this evidence.
    """
    if (
        not history.verified
        or not source_digest
        or source_digest != history.source_digest
        or account.get("positions_status") != "verified"
        or not isinstance(account.get("positions"), list)
        or account.get("cash_gbp") is None
        or not history.account_state_digest
    ):
        return None
    observed = _instant(account.get("fetched_at"))
    if observed is None or observed <= history.covered_until:
        return None
    digest = account_state_digest(account)
    if digest == history.account_state_digest:
        return history.model_copy(update={"covered_until": observed})
    events = _live_cash_only_events(history, account, observed, baselines, live_cash)
    if events is None:
        return None
    return history.model_copy(
        update={
            "covered_until": observed,
            "events": [*history.events, *events],
            "account_state_digest": digest,
        }
    )
