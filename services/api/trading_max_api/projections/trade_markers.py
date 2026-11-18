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


def _side_average(groups: list[tuple[dict, list[dict]]], side: str) -> float | None:
    """Use observed prices, or an older whole-side average with a provable weight."""
    prices = []
    for row, selected in groups:
        fills = [f for f in selected if f["side"] == side]
        if not fills:
            continue
        if all("price" in f for f in fills):
            prices.extend(
                (f["price"], f["quantity"])
                for f in fills
                if f["price"] is not None and f["quantity"] > 0
            )
        elif len(fills) != row[f"{side}_orders"]:
            # A prior publication's average also includes fills on another listing.
            return None
        elif (average := row[f"{side}_average_price"]) is not None:
            # Older multi-order groups omit the quantity for which a price was observed.
            prices.append((average, fills[0]["quantity"] if len(fills) == 1 else None))
    if not prices:
        return None
    distinct = {price for price, _ in prices}
    if len(distinct) == 1:
        return round(distinct.pop(), 8)
    if any(weight is None for _, weight in prices):
        return None
    quantity = sum(weight for _, weight in prices)
    return (
        round(sum(price * weight for price, weight in prices) / quantity, 8) if quantity else None
    )


def _daily_marker(ticker: str, groups: list[tuple[dict, list[dict]]]) -> ResearchTradeMarker:
    first, selected = groups[0]
    if len(groups) == 1 and len(first["fills"]) == len(selected):
        return ResearchTradeMarker.model_validate({**first, "ticker": ticker})
    fills = sorted((fill for _, group in groups for fill in group), key=lambda f: f["at"])
    buys = [f for f in fills if f["side"] == "buy"]
    sells = [f for f in fills if f["side"] == "sell"]
    return ResearchTradeMarker(
        ticker=ticker,
        date=first["date"],
        kind="T" if buys and sells else "B" if buys else "S",
        accounts=sorted({f["account"] for f in fills}),
        fills=fills,
        buy_orders=len(buys),
        sell_orders=len(sells),
        buy_quantity=round(sum(f["quantity"] for f in buys), 8),
        sell_quantity=round(sum(f["quantity"] for f in sells), 8),
        buy_average_price=_side_average(groups, "buy"),
        sell_average_price=_side_average(groups, "sell"),
    )


def chart_trade_markers(
    payload: dict, ticker: str, published_listings: Callable[[], dict[str, set[str]]]
) -> tuple[list[ResearchTradeMarker], dict[str, set[str]] | None]:
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return [], None
    legacy = payload.get("calculation_version") in {None, "trade-markers-v1", "trade-markers-v2"}
    labels = {ticker, ticker.partition(".")[0]}

    aliases = None
    matches = []
    daily_fills = defaultdict(list)
    unresolved = defaultdict(set)
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = str(row.get("ticker") or "").strip().upper()
        fills = row.get("fills") or []
        if legacy and not any("broker_ticker" in fill for fill in fills):
            if aliases is None:
                aliases = published_listings()
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
            fill_label = str(instrument or "").strip().upper()
            if symbol is None and fill_label in labels:
                # A CSV may record only a ticker. Resolve the fill's own text, never
                # the daily marker label (which can follow an ISIN across listings).
                if aliases is None:
                    aliases = published_listings()
                if aliases.get(fill_label) == {ticker}:
                    symbol = ticker
            if symbol == ticker:
                selected.append(fill)
            elif symbol is None and (label in labels or fill_label in labels):
                unresolved[row["date"]].add(fill["account"])
        if selected:
            daily_fills[row["date"]].append((row, selected))
    matches.extend(_daily_marker(ticker, group) for group in daily_fills.values())
    return sorted(matches, key=lambda marker: marker.date), dict(unresolved)
