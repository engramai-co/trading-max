"""Dated GICS sector weights from the iShares Core MSCI World UCITS ETF (SWDA)."""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import date, datetime, timedelta
from math import fsum, isclose
from pathlib import Path
from typing import Any

import httpx
from pydantic import Field

from trading_max.domain import DomainModel

from .fund_holdings import _atomic_json, _iso_date, _number
from .sector_universe import (
    GICS_SECTORS,
    SECTOR_ALIASES,
    fetch_ishares_holdings,
    ishares_holdings_client,
)

LOGGER = logging.getLogger(__name__)
SWDA_PRODUCT = "251882"
MAX_AGE = timedelta(days=7)
BACKOFF = timedelta(minutes=30)
TOP_HOLDINGS = 8


class WorldSectorHolding(DomainModel):
    name: str
    weight: float


class WorldSectorWeight(DomainModel):
    weight: float
    holdings: list[WorldSectorHolding]


class WorldSectorWeights(DomainModel):
    as_of: date
    fetched_at: datetime
    sectors: dict[str, WorldSectorWeight] = Field(min_length=1)


def aggregate_world_sector_weights(points: Mapping[str, Any], now: datetime) -> WorldSectorWeights:
    """Preserve shares of fund NAV; exclude cash and unmapped exposures."""
    fields = [
        points[key]["value"]
        for key in ("sectorName", "holdingPercent", "assetClass", "issueName", "isin")
    ]
    if any(not isinstance(column, list) for column in fields):
        raise ValueError("SWDA holdings columns must be arrays")
    if len({len(column) for column in fields}) != 1:
        raise ValueError("SWDA holdings columns have different lengths")
    if not isclose(fsum(_number(v) for v in fields[1]), 100, abs_tol=0.2):
        raise ValueError("SWDA holdings do not reconcile to fund NAV")
    totals: defaultdict[str, list[float]] = defaultdict(list)
    holdings: defaultdict[str, dict[tuple[str, str], list[float]]] = defaultdict(dict)
    for sector, raw, kind, name, isin in zip(*fields, strict=True):
        label = str(sector or "").strip()
        code = GICS_SECTORS.get(SECTOR_ALIASES.get(label, label))
        weight = _number(raw) / 100
        if code is None or kind != "Equity" or weight <= 0:
            continue
        totals[code].append(weight)
        name = " ".join(str(name or "").split())
        if name:
            holdings[code].setdefault((str(isin or name), name), []).append(weight)
    stamp = date.fromisoformat(_iso_date(points["asOfDate"]["value"]))
    if stamp > now.date():
        raise ValueError("SWDA holdings are dated in the future")
    return WorldSectorWeights(
        as_of=stamp,
        fetched_at=now,
        sectors={
            code: WorldSectorWeight(
                weight=fsum(weights),
                holdings=sorted(
                    (
                        WorldSectorHolding(name=name, weight=fsum(values))
                        for (_, name), values in holdings[code].items()
                    ),
                    key=lambda row: (-row.weight, row.name),
                )[:TOP_HOLDINGS],
            )
            for code, weights in totals.items()
        },
    )


class WorldSectorWeightsProvider:
    """Persist only public weights and top holdings, with a last-good fallback."""

    def __init__(
        self, root: Path, fetch: Callable[[datetime], WorldSectorWeights] | None = None
    ) -> None:
        self.path = root / "research-cache" / "sector-universe" / "swda-sector-weights.json"
        self.fetch = fetch or self._fetch
        self._weights: WorldSectorWeights | None = None
        self._retry_at: datetime | None = None

    @staticmethod
    def _fetch(now: datetime) -> WorldSectorWeights:
        with ishares_holdings_client(timeout=6.0) as client:
            return aggregate_world_sector_weights(fetch_ishares_holdings(SWDA_PRODUCT, client), now)

    def get(self, now: datetime) -> tuple[WorldSectorWeights | None, bool]:
        if self._weights is None:
            with suppress(OSError, ValueError):
                self._weights = WorldSectorWeights.model_validate_json(self.path.read_bytes())
        cached = self._weights
        if cached and timedelta(0) <= now - cached.fetched_at <= MAX_AGE:
            return cached, False
        if self._retry_at is not None and now < self._retry_at:
            return cached, cached is not None
        try:
            weights = self.fetch(now)
            if cached and weights.as_of < cached.as_of:
                raise ValueError("SWDA holdings moved backward")
        except (httpx.HTTPError, RuntimeError, KeyError, TypeError, ValueError):
            LOGGER.debug("SWDA holdings read failed", exc_info=True)
            self._retry_at = now + BACKOFF
            return cached, cached is not None
        self._weights = weights
        try:
            _atomic_json(self.path, weights.model_dump(mode="json", by_alias=True))
        except OSError:
            LOGGER.debug("SWDA weights cache could not be written", exc_info=True)
        return weights, False
