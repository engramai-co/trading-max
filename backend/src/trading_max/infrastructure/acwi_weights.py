"""Dated country weights from the iShares MSCI ACWI UCITS ETF (SSAC)."""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from pydantic import Field

from trading_max.domain import DomainModel

from .fund_holdings import _atomic_json, _country, _iso_date, _number
from .sector_universe import fetch_ishares_holdings, ishares_holdings_client

LOGGER = logging.getLogger(__name__)
SSAC_PRODUCT = "251850"
MAX_AGE = timedelta(days=7)
BACKOFF = timedelta(minutes=30)
# Revision of the aggregation below. A cached file from an older revision is refetched.
METHOD = 2
# SSAC reaches some markets through iShares country funds, which the holdings list
# under each fund's own domicile. Their weight belongs to the market the fund holds.
COUNTRY_FUNDS = {
    "IE00BZCQB185": "India",  # iShares MSCI India UCITS ETF
    "IE00BQT3WG13": "China",  # iShares MSCI China A UCITS ETF
    "IE00BYYR0489": "Saudi Arabia",  # iShares MSCI Saudi Arabia Capped UCITS ETF
    "DE000A0Q4R85": "Brazil",  # iShares MSCI Brazil UCITS ETF (DE)
}


class AcwiWeights(DomainModel):
    as_of: date
    fetched_at: datetime
    locations: dict[str, float] = Field(min_length=1)
    method: int = 1


def aggregate_acwi_weights(points: Mapping[str, Any], now: datetime) -> AcwiWeights:
    """Aggregate equity as a share of total fund NAV, without renormalising it."""
    fields = [points[key]["value"] for key in ("countryOfRisk", "holdingPercent", "assetClass")]
    if any(not isinstance(column, list) for column in fields):
        raise ValueError("SSAC holdings columns must be arrays")
    if len({len(column) for column in fields}) != 1:
        raise ValueError("SSAC holdings columns have different lengths")
    if not math.isclose(sum(_number(v) for v in fields[1]), 100, abs_tol=0.2):
        raise ValueError("SSAC holdings do not reconcile to fund NAV")
    isins = (points.get("isin") or {}).get("value")
    if not isinstance(isins, list) or len(isins) != len(fields[0]):
        isins = [None] * len(fields[0])
    locations: dict[str, float] = {}
    for location, raw, kind, isin in zip(*fields, isins, strict=True):
        weight = _number(raw)
        if kind == "Equity" and weight > 0:
            key = COUNTRY_FUNDS.get(str(isin or "").strip().upper()) or _country(
                location, default="Unclassified"
            )
            locations[key] = locations.get(key, 0) + weight / 100
    stamp = date.fromisoformat(_iso_date(points["asOfDate"]["value"]))
    if stamp > now.date():
        raise ValueError("SSAC holdings are dated in the future")
    return AcwiWeights(as_of=stamp, fetched_at=now, locations=locations, method=METHOD)


class AcwiWeightsProvider:
    """Store only aggregated public weights; preserve the last good file on failure."""

    def __init__(self, root: Path, fetch: Callable[[datetime], AcwiWeights] | None = None) -> None:
        self.path = root / "research-cache" / "sector-universe" / "acwi-weights.json"
        self.fetch = fetch or self._fetch
        self._weights: AcwiWeights | None = None
        self._retry_at: datetime | None = None

    @staticmethod
    def _fetch(now: datetime) -> AcwiWeights:
        with ishares_holdings_client(timeout=6.0) as client:
            return aggregate_acwi_weights(fetch_ishares_holdings(SSAC_PRODUCT, client), now)

    def get(self, now: datetime) -> tuple[AcwiWeights | None, bool]:
        if self._weights is None:
            with suppress(OSError, ValueError):
                self._weights = AcwiWeights.model_validate_json(self.path.read_bytes())
        cached = self._weights
        current = cached is not None and cached.method == METHOD
        if cached and current and timedelta(0) <= now - cached.fetched_at <= MAX_AGE:
            return cached, False
        if self._retry_at is not None and now < self._retry_at:
            return cached, cached is not None
        try:
            weights = self.fetch(now)
            if cached and current and weights.as_of < cached.as_of:
                raise ValueError("SSAC holdings moved backward")
        except (httpx.HTTPError, RuntimeError, KeyError, TypeError, ValueError):
            LOGGER.debug("SSAC holdings read failed", exc_info=True)
            self._retry_at = now + BACKOFF
            return cached, cached is not None
        self._weights = weights
        try:
            _atomic_json(self.path, weights.model_dump(mode="json", by_alias=True))
        except OSError:
            LOGGER.debug("SSAC weights cache could not be written", exc_info=True)
        return weights, False
