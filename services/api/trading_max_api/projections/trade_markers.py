"""Join broker fills to the listing that supplied a chart's published bars."""

from collections import defaultdict
from collections.abc import Callable

from trading_max.research.listing import LONDON, broker_listing

from ..dashboard_models import ResearchTradeMarker


def broker_symbol(instrument: str | None) -> str | None:
    listing = broker_listing(instrument)
    if listing is None:
        return None
    market, symbol = listing.split(":", 1)
    return symbol + ".L" if market == LONDON else symbol


def _selected_fills(row: dict, ticker: str, selected: list[dict]) -> ResearchTradeMarker:
    resolved = {**row, "ticker": ticker}
    if len(selected) != len(row["fills"]):
        # Some publications combined several listings in a daily summary. A side's
        # average price is usable only when all its fills belong to this listing.
        resolved.update(fills=selected, accounts=sorted({f["account"] for f in selected}))
        for side in ("buy", "sell"):
            side_fills = [f for f in selected if f["side"] == side]
            resolved[f"{side}_orders"] = len(side_fills)
            resolved[f"{side}_quantity"] = round(sum(f["quantity"] for f in side_fills), 8)
            if not side_fills or len(side_fills) != row[f"{side}_orders"]:
                resolved[f"{side}_average_price"] = None
        sides = frozenset(f["side"] for f in selected)
        resolved["kind"] = {frozenset({"buy"}): "B", frozenset({"sell"}): "S"}.get(sides, "T")
    return ResearchTradeMarker.model_validate(resolved)


def chart_trade_markers(
    payload: dict, ticker: str, legacy_listings: Callable[[], dict[str, set[str]]]
) -> tuple[list[ResearchTradeMarker], dict[str, set[str]] | None]:
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return [], None
    legacy = payload.get("calculation_version") in {None, "trade-markers-v1", "trade-markers-v2"}
    labels = {ticker, ticker.removesuffix(".L")}

    aliases = None
    matches = []
    unresolved = defaultdict(set)
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = str(row.get("ticker") or "").strip().upper()
        fills = row.get("fills") or []
        if legacy and not any("broker_ticker" in fill for fill in fills):
            if aliases is None:
                aliases = legacy_listings()
            # US export codes retain their venue when uppercased; a case-erased
            # London code needs a matching broker instrument in this snapshot.
            explicit = broker_symbol(row.get("ticker"))
            candidates = aliases.get(label, set())
            if explicit in aliases:
                candidates = candidates | {explicit}
            if candidates == {ticker}:
                matches.append(ResearchTradeMarker.model_validate({**row, "ticker": ticker}))
            elif ticker in candidates:
                unresolved[row["date"]].update(row.get("accounts") or [])
            continue
        selected = []
        for fill in fills:
            instrument = fill.get("broker_ticker")
            symbol = broker_symbol(instrument)
            if symbol == ticker:
                selected.append(fill)
            elif symbol is None and (label in labels or str(instrument or "").upper() in labels):
                unresolved[row["date"]].add(fill["account"])
        if selected:
            matches.append(_selected_fills(row, ticker, selected))
    return matches, dict(unresolved)
