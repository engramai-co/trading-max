"""Only pair a listing's unadjusted market price and NAV at the same instant."""

from __future__ import annotations

import csv
from datetime import UTC, datetime
from io import StringIO
from math import isfinite
from pathlib import Path
from urllib.parse import urlparse

from trading_max.domain.contracts import DomainModel
from trading_max.reference.fund_benchmarks import fund_benchmark
from trading_max.reference.quote_units import major_quote_unit


class FundPremiumObservation(DomainModel):
    at: datetime
    price: float
    nav: float
    currency: str
    premium: float


class FundPremiumDiscount(DomainModel):
    isin: str
    ticker: str
    source_url: str
    points: list[FundPremiumObservation]


def premium_file(root: Path, isin: str, ticker: str) -> Path | None:
    mapping = fund_benchmark(isin)
    if not mapping or ticker != (
        mapping.ticker + ".L" if mapping.domicile == "IE" else mapping.ticker
    ):
        return None
    return root / "reference" / "fund-premium-discount" / f"{isin}-{ticker}.json"


def paired_premiums(isin: str, ticker: str, source: str, data: str) -> FundPremiumDiscount:
    source_url = urlparse(source)
    if source_url.scheme != "https" or not source_url.hostname or source_url.username:
        raise ValueError("provide an issuer HTTPS source")
    if premium_file(Path(), isin, ticker) is None:
        raise ValueError("unsupported-issuer-listing")
    rows = {}
    for row in csv.DictReader(StringIO(data)):
        try:
            if (
                row.get("listing") != ticker
                or row.get("isin") != isin
                or row.get("price_basis") != "unadjusted"
            ):
                continue
            market_at = datetime.fromisoformat(row["market_at"])
            nav_at = datetime.fromisoformat(row["nav_at"])
            if market_at.tzinfo is None or nav_at.tzinfo is None or market_at != nav_at:
                continue
            quote, price_divisor = major_quote_unit(row["price_currency"])
            nav_ccy, nav_divisor = major_quote_unit(row["nav_currency"])
            price, nav = float(row["market_price"]) / price_divisor, float(row["nav"]) / nav_divisor
            if (
                not quote
                or quote != nav_ccy
                or not all(isfinite(v) and v > 0 for v in (price, nav))
            ):
                continue
        except (ValueError, KeyError, TypeError):
            continue
        premium = price / nav - 1
        if not isfinite(premium):
            continue
        point = FundPremiumObservation(
            at=market_at.astimezone(UTC),
            price=price,
            nav=nav,
            currency=quote,
            premium=premium,
        )
        if point.at in rows and rows[point.at] != point:
            raise ValueError("conflicting-premium-observations")
        rows[point.at] = point
    if not rows:
        raise ValueError("no-exact-time-premium-observations")
    return FundPremiumDiscount(
        isin=isin,
        ticker=ticker,
        source_url=source,
        points=[point for _, point in sorted(rows.items())],
    )
