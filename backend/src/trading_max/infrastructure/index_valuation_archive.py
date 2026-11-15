"""Private, dated valuation observations; source kinds do not share a time series."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import isfinite
from pathlib import Path
from typing import Literal

from pydantic import Field

from trading_max.domain.contracts import DomainModel
from trading_max.reference.indices import INDEX_REGISTRY

from .durable_files import atomic_bytes
from .sector_universe import SectorUniverse


class ValuationObservation(DomainModel):
    index_id: str
    source_kind: Literal["official", "fund-proxy", "us-bottom-up"]
    source_url: str
    method: str
    as_of: date
    recorded_at: datetime
    basket_as_of: date | None = None
    pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    forward_pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    price_to_book: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    coverage: float | None = Field(default=None, ge=0, le=1)
    sample_size: int | None = Field(default=None, ge=0)
    basket_size: int | None = Field(default=None, ge=0)


def archive_valuation(root: Path, row: ValuationObservation) -> None:
    if row.index_id not in INDEX_REGISTRY or row.recorded_at.tzinfo is None:
        raise ValueError("invalid-valuation-identity")
    if row.as_of > row.recorded_at.date():
        raise ValueError("valuation-observation-is-in-the-future")
    file = root / row.index_id / row.source_kind / f"{row.as_of}.json"
    previous = _prior_observation(file)
    if previous is not None and (
        previous.recorded_at > row.recorded_at
        or (row.source_kind == "us-bottom-up" and (previous.coverage or 0) > (row.coverage or 0))
        or previous.model_dump(exclude={"recorded_at"}) == row.model_dump(exclude={"recorded_at"})
    ):
        return
    atomic_bytes(file, row.model_dump_json().encode())


def _prior_observation(path: Path) -> ValuationObservation | None:
    try:
        return ValuationObservation.model_validate_json(path.read_bytes())
    except (OSError, ValueError):
        return None


@dataclass(frozen=True)
class _Fact:
    start: date | None
    end: date
    filed: date
    value: float

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1 if self.start else 0


def _facts(data: dict, unit: str, cutoff: date) -> list[_Fact]:
    selected = {}
    for row in data.get("units", {}).get(unit, []):
        try:
            if row["form"] not in {"10-K", "10-Q", "10-K/A", "10-Q/A"}:
                continue
            filed, end = date.fromisoformat(row["filed"]), date.fromisoformat(row["end"])
            start = date.fromisoformat(row["start"]) if "start" in row else None
            value = float(row["val"])
        except (TypeError, ValueError, KeyError):
            continue
        # Companyfacts supplies the filing date without its intraday timestamp.
        if end > cutoff or filed >= cutoff or not isfinite(value):
            continue
        key = start, end
        if key not in selected or selected[key].filed <= filed:
            selected[key] = _Fact(start, end, filed, value)
    return list(selected.values())


def _annual_profit(facts: list[_Fact], cutoff: date) -> float | None:
    annuals = [fact for fact in facts if 350 <= fact.days <= 380]
    last = max(annuals, key=lambda row: row.end, default=None)
    if last is None:
        return None
    interim = max(
        (
            fact
            for fact in facts
            if 70 <= fact.days < 300
            and fact.end > last.end
            and fact.start
            and 1 <= (fact.start - last.end).days <= 8
        ),
        key=lambda row: row.end,
        default=None,
    )
    if interim is not None and (cutoff - interim.end).days <= 180:
        prior = [
            row
            for row in facts
            if row.start
            and last.start
            and abs((row.start - last.start).days) <= 8
            and abs(row.days - interim.days) <= 8
            and 350 <= (interim.end - row.end).days <= 380
        ]
        if prior:
            return last.value + interim.value - max(prior, key=lambda row: row.filed).value
        return None
    return last.value if (cutoff - last.end).days <= 180 else None


def sec_earnings_yield(payload: dict, cutoff: date, close: float) -> float | None:
    """Use dated TTM GAAP net income and observed common shares outstanding."""
    if not isfinite(close) or close <= 0:
        return None
    facts = payload.get("facts", {})
    earnings = _annual_profit(
        _facts(facts.get("us-gaap", {}).get("NetIncomeLoss", {}), "USD", cutoff),
        cutoff,
    )
    shares = max(
        (
            row
            for row in _facts(
                facts.get("dei", {}).get("EntityCommonStockSharesOutstanding", {}), "shares", cutoff
            )
            if (cutoff - row.end).days <= 180 and row.value > 0
        ),
        key=lambda row: row.end,
        default=None,
    )
    return earnings / (shares.value * close) if earnings is not None and shares else None


def bottom_up_valuation(
    source_root: Path,
    index_id: str,
    universe: SectorUniverse,
    closes: dict[str, float],
    day: date,
    now: datetime,
) -> ValuationObservation | None:
    """Consume an operator-staged SEC companyfacts snapshot without network traffic."""
    try:
        ticker_list = json.loads((source_root / "company_tickers.json").read_bytes()).values()
        mapping = {
            row["ticker"].upper().replace(".", "-"): int(row["cik_str"]) for row in ticker_list
        }
        basket_day = date.fromisoformat(universe.as_of)
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        return None
    if basket_day > day or day - basket_day > timedelta(days=10):
        return None
    listings = [row for row in universe.constituents if row.weight > 0]
    total = sum(row.weight for row in listings)
    counts = Counter(mapping.values())
    eligible = []
    for row in listings:
        cik, close = mapping.get(row.symbol), closes.get(row.symbol)
        # Do not divide issuer-wide net income by only one listed share class.
        if cik is None or counts[cik] != 1 or close is None or not row.isin.startswith("US"):
            continue
        try:
            payload = json.loads((source_root / f"CIK{cik:010d}.json").read_bytes())
            if int(payload["cik"]) != cik:
                continue
            earnings_yield = sec_earnings_yield(payload, day, close)
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue
        if earnings_yield is not None and isfinite(earnings_yield):
            eligible.append((row.weight, earnings_yield))
    if not eligible or not total:
        return None
    covered = sum(weight for weight, _ in eligible)
    earnings = sum(weight * earnings_yield for weight, earnings_yield in eligible)
    return ValuationObservation(
        index_id=index_id,
        source_kind="us-bottom-up",
        source_url="https://www.sec.gov/search-filings/edgar-application-programming-interfaces",
        method="GAAP TTM net income / common equity market cap, weighted harmonic P/E; signed earnings",
        as_of=day,
        recorded_at=now,
        basket_as_of=basket_day,
        pe=covered / earnings if earnings > 0 else None,
        coverage=min(1, covered / total),
        sample_size=len(eligible),
        basket_size=len(listings),
    )
