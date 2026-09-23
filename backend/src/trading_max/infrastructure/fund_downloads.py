"""Validation shared by official issuer downloads, independent of transport/cache."""

from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

import pandas as pd

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot

from .fund_specs import FundSpec


def issuer_url(value: str, base: str) -> str:
    """Follow catalogue links only within the expected official HTTPS origin."""
    result = urljoin(base, value)
    parsed, origin = urlsplit(result), urlsplit(base)
    if (
        parsed.scheme != "https"
        or parsed.hostname != origin.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ValueError("holdings link leaves the official issuer origin")
    return result


def text(value: object) -> str:
    result = str(value).strip() if value is not None else ""
    return "" if result.lower() in {"", "-", "--", "nan", "none", "unassigned", "n/a"} else result


def percentage(value: object) -> float:
    result = float(text(value).replace(",", "").removesuffix("%").strip())
    if not math.isfinite(result):
        raise ValueError("non-finite constituent weight")
    return result


def isin(value: object) -> str:
    candidate = text(value).upper()
    return candidate if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", candidate) else ""


def as_of_date(value: object) -> str:
    raw = re.sub(r"^(As of|as at)\s+", "", text(value), flags=re.I)
    if not raw:
        raise ValueError("official holdings have no as-of date")
    parsed = pd.to_datetime(raw, errors="raise", dayfirst=not bool(re.match(r"^\d{4}-", raw)))
    if pd.isna(parsed):
        raise ValueError("official holdings have an invalid as-of date")
    return parsed.date().isoformat()


def make_snapshot(
    spec: FundSpec,
    holdings: list[FundHolding],
    date: object,
    *,
    unweighted: int = 0,
) -> FundSnapshot:
    """Keep issuer units and residuals; never stretch a top-ten list to 100%."""
    if not holdings or any(not math.isfinite(row.weight_pct) for row in holdings):
        raise ValueError(f"{spec.ticker}: empty or invalid official holdings")
    total = sum(row.weight_pct for row in holdings)
    if not math.isclose(total, 100.0, abs_tol=0.2):
        raise ValueError(f"{spec.ticker}: weights reconcile to {total:.4f}%, not 100%")
    countries: defaultdict[str, float] = defaultdict(float)
    industries: defaultdict[str, float] = defaultdict(float)
    for row in holdings:
        countries[(row.country or "Unclassified") if row.is_security else "Cash & derivatives"] += (
            row.weight_pct
        )
        industries[
            (row.industry or "Unclassified") if row.is_security else "Cash & derivatives"
        ] += row.weight_pct
    date_string = as_of_date(date)
    return FundSnapshot(
        ticker=spec.ticker,
        fund_isin=spec.isin,
        as_of=date_string,
        industry_as_of=date_string,
        fetched_at=datetime.now(UTC).isoformat(),
        cache_schema_version=3,
        holdings=holdings,
        country_weights=dict(countries),
        industry_weights=dict(industries),
        source_url=spec.source_url,
        issuer=spec.issuer,
        unweighted_holdings_count=unweighted,
    )
