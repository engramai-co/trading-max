"""Versioned exact-ISIN cross-listings for historical market data.

Broker exports identify instruments by ISIN but their display ticker may point
to a provider listing with incomplete history.  This adapter exposes only
issuer-documented listings of the *same instrument*.  It never substitutes an
underlying share, ADR, or economically similar security.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

_DEFAULT_DATA_PATH = Path(__file__).with_name("data") / "historical-price-listings-2026.08.json"


def _camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class _ReferenceModel(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True)


class HistoricalListing(_ReferenceModel):
    """One provider symbol for an issuer-documented exchange listing."""

    symbol: str
    quote_currency: str
    mic: str


class HistoricalListingRecord(_ReferenceModel):
    """All known provider listings for one exact instrument identity."""

    isin: str
    name: str
    listings: tuple[HistoricalListing, ...]
    sources: tuple[str, ...]

    @field_validator("isin")
    @classmethod
    def validate_isin(cls, value: str) -> str:
        normalized = value.strip().upper()
        if len(normalized) != 12 or not normalized.isalnum():
            raise ValueError(f"invalid ISIN: {value!r}")
        return normalized


class HistoricalListingDataset(_ReferenceModel):
    """Validated historical listing adapter dataset."""

    schema_version: int
    dataset_id: str
    provider: str
    as_of: str
    match_policy: str
    records: tuple[HistoricalListingRecord, ...] = Field(default_factory=tuple)

    @field_validator("records")
    @classmethod
    def unique_isins(
        cls,
        records: tuple[HistoricalListingRecord, ...],
    ) -> tuple[HistoricalListingRecord, ...]:
        isins = [record.isin for record in records]
        if len(isins) != len(set(isins)):
            raise ValueError("duplicate historical-listing ISIN")
        return records


@lru_cache(maxsize=1)
def historical_listing_dataset() -> HistoricalListingDataset:
    """Load and validate the bundled cross-listing dataset once per process."""

    payload = json.loads(_DEFAULT_DATA_PATH.read_text(encoding="utf-8"))
    return HistoricalListingDataset.model_validate(payload)


def historical_listing_symbols(isin: str | None) -> tuple[str, ...]:
    """Return provider symbols documented for the exact ISIN, in source order."""

    normalized = (isin or "").strip().upper()
    if not normalized:
        return ()
    for record in historical_listing_dataset().records:
        if record.isin == normalized:
            return tuple(listing.symbol for listing in record.listings)
    return ()


__all__ = [
    "HistoricalListing",
    "HistoricalListingDataset",
    "HistoricalListingRecord",
    "historical_listing_dataset",
    "historical_listing_symbols",
]
