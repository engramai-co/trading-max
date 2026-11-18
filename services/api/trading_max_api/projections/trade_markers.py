"""Join broker fills to the listing that supplied a chart's published bars."""

from collections import defaultdict
from collections.abc import Callable

from trading_max.analytics.trade_prices import average_fill_price
from trading_max.research.listing import LONDON, broker_listing

from ..dashboard_models import ResearchTradeMarker


def broker_symbol(instrument: str | None) -> str | None:
    listing = broker_listing(instrument)
    if listing is None:
        return None
    market, symbol = listing.split(":", 1)
    return symbol + ".L" if market == LONDON else symbol


def _daily_marker(
    ticker: str, day: str, currency: str, fills: list[dict], aggregates: list[dict]
) -> ResearchTradeMarker:
    # Aggregates predate itemised fills. Preserve their known totals and account sets.
    fills.sort(key=lambda fill: fill["at"])
    accounts = {f["account"] for f in fills}
    aggregate_sides = []
    for row in aggregates:
        accounts.update(row["accounts"])
        aggregate_sides.append((row["accounts"], row["kind"]))
    totals = {}
    for side in ("buy", "sell"):
        selected = [f for f in fills if f["side"] == side]
        archived_orders = sum(row[f"{side}_orders"] for row in aggregates)
        totals[f"{side}_orders"] = len(selected) + archived_orders
        totals[f"{side}_quantity"] = round(
            sum(f["quantity"] for f in selected)
            + sum(row[f"{side}_quantity"] for row in aggregates),
            8,
        )
        totals[f"{side}_average_price"] = (
            None if archived_orders else average_fill_price(selected, side, currency)
        )
    return ResearchTradeMarker(
        ticker=ticker,
        date=day,
        kind="T"
        if totals["buy_orders"] and totals["sell_orders"]
        else "B"
        if totals["buy_orders"]
        else "S",
        accounts=sorted(accounts),
        fills=fills,
        aggregate_sides=aggregate_sides,
        **totals,
    )


def chart_trade_markers(
    payload: dict, ticker: str, currency: str, published_listings: Callable[[], dict[str, set[str]]]
) -> tuple[list[ResearchTradeMarker], dict[str, set[str]] | None]:
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return [], None
    legacy = payload.get("calculation_version") in {None, "trade-markers-v1", "trade-markers-v2"}
    labels = {ticker, ticker.partition(".")[0]}

    aliases = None
    daily_fills = defaultdict(list)
    daily_aggregates = defaultdict(list)
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
                if fills:
                    daily_fills[row["date"]].extend(fills)
                else:
                    daily_aggregates[row["date"]].append(row)
            elif ticker in candidates:
                unresolved[row["date"]].update(row.get("accounts") or [])
            continue
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
                daily_fills[row["date"]].append(fill)
            elif symbol is None and (label in labels or fill_label in labels):
                unresolved[row["date"]].add(fill["account"])
    markers = [
        _daily_marker(ticker, day, currency, daily_fills[day], daily_aggregates[day])
        for day in sorted(daily_fills.keys() | daily_aggregates.keys())
    ]
    return markers, dict(unresolved)
