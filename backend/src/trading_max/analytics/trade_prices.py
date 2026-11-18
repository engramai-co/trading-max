"""Share-weighted execution prices in the chart's quote unit."""

from datetime import datetime
from math import isfinite

from trading_max.reference.quote_units import major_quote_unit

from .fx import FxResolver, resolve_fx


def _positive(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) and number > 0 else None


def _quoted_prices(fill: dict) -> dict[str, float]:
    """Per-share prices in major units, using only the fill's declared currency pair."""
    quote, quote_divisor = major_quote_unit(fill.get("price_currency") or "")
    price = _positive(fill.get("price"))
    if not quote or price is None:
        return {}
    prices = {quote: price / quote_divisor}
    wallet, wallet_divisor = major_quote_unit(fill.get("currency") or "")
    rate = _positive(fill.get("exchange_rate"))
    if wallet and wallet != quote and rate is not None:
        # Trading 212 reports quote units per settlement unit.
        prices[wallet] = price / rate / wallet_divisor
    return prices


def record_price_fx(fill: dict, targets: set[str], resolver: FxResolver | None) -> None:
    """Pin earlier FX observations for chart currencies outside the broker's currency pair."""
    if resolver is None:
        return
    direct = _quoted_prices(fill)
    missing = targets.difference(direct)
    if not direct or not missing:
        return
    at = datetime.fromisoformat(fill["at"])
    rates = {}
    currencies = missing if "GBP" in direct else direct.keys() | missing
    for currency in sorted(currencies - {"GBP"}):
        if fx := resolve_fx(currency, at, resolver=resolver):
            rates[currency] = fx.as_dict()
    if rates:
        fill["price_fx"] = rates


def _chart_price(fill: dict, currency: str) -> float | None:
    target, divisor = major_quote_unit(currency)
    direct = _quoted_prices(fill)
    if target in direct:
        return direct[target] * divisor
    # Crosses use only the observations published for this execution.
    rates = {"GBP": 1.0}
    for code, quote in (fill.get("price_fx") or {}).items():
        if rate := _positive(quote.get("native_per_gbp")):
            rates[code] = rate
    if target in rates:
        if "GBP" in direct:
            return direct["GBP"] * rates[target] * divisor
        for code, amount in direct.items():
            if code in rates:
                return amount / rates[code] * rates[target] * divisor
    return None


def average_fill_price(fills: list[dict], side: str, currency: str) -> float | None:
    cost = 0.0
    priced_quantity = 0.0
    for fill in fills:
        quantity = fill["quantity"]
        if fill["side"] != side or quantity <= 0:
            continue
        if "price" not in fill:
            # Older publications have no evidence for the unit of their side average.
            return None
        if fill["price"] is None:
            continue
        price = _chart_price(fill, currency)
        if price is None:
            return None
        cost += quantity * price
        priced_quantity += quantity
    return round(cost / priced_quantity, 8) if priced_quantity else None
