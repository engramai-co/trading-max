"""Prepare full-resolution accounting and look up exact P&L observations."""

from collections.abc import Sequence

from ._js import exact_instant as exact_instant
from ._js import parse_date
from .history import select_portfolio_history
from .money import portfolio_money
from .types import HistoryInput, HistorySelection, PreparedAmounts, PreparedHistory

SYNC_MS = 5 * 60_000


def prepare_history(data: HistoryInput, selection: HistorySelection) -> PreparedHistory:
    """Mirror prepareHistory's full calculation; the chart payload is presentation only."""
    history = select_portfolio_history(
        daily=data.get("nav", ()),
        intraday=data.get("intradayNav", ()),
        as_of=data["brokerAsOf"],
        require_cash_flows=True,
        range=selection["range"],
        scope=selection["scope"],
    )
    return {
        "runId": data["runId"],
        "dataRevision": data["dataRevision"],
        "sourceCount": len(history["points"]),
        "history": history,
        "money": portfolio_money(history["points"], selection["scope"]),
    }


def pnls_at(prepared: PreparedAmounts, instants: Sequence[str]) -> dict[str, float | None]:
    times = [
        parse_date(point["date"]) if "T" in point["date"] else None
        for point in prepared["history"]["points"]
    ]
    result = {}
    for at in instants:
        instant = exact_instant(at)
        index = (
            next(
                (
                    i
                    for i, time in enumerate(times)
                    if time is not None and instant <= time <= instant + SYNC_MS
                ),
                None,
            )
            if instant is not None
            else None
        )
        result[at] = None if index is None else prepared["money"]["pnls"][index]
    return result
