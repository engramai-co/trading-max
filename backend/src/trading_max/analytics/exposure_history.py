"""Dated references to the published Holdings look-through, using London dates."""

import json
from datetime import date, datetime, timedelta
from functools import cache
from importlib.resources import files
from zoneinfo import ZoneInfo

from trading_max.domain.contracts import ArtifactRef
from trading_max.infrastructure import ContentAddressedArtifactStore

PREFIX = "account/exposure_history/"
RECENT_DAYS = 35
RETAIN_MONTHS = 60
TOP_COMPANIES = 40
DIMENSIONS = {
    "country": ("countryAllocation", "country", "countryBasis"),
    "sector": ("industryAllocation", "industry", "industryBasis"),
    "gics": ("gicsSubIndustryAllocation", "subIndustry", "gicsSubIndustryBasis"),
    "company": ("positions", "name", None),
}


@cache
def _countries() -> dict[str, str]:
    return json.loads(
        files("trading_max.reference").joinpath("data/exposure-country-codes.json").read_text()
    )


def exposure_rows(raw: dict, dimension: str) -> list[dict]:
    rows_key, name_key, _ = DIMENSIONS[dimension]
    rows = raw.get(rows_key) or []
    if dimension == "country":
        merged = {}
        for row in rows:
            label = row.get(name_key) or ""
            key = _countries().get(label.strip().lower(), label)
            if key not in merged:
                merged[key] = dict(row)
            else:
                for field in ("allocationPct", "valueGbp"):
                    a, b = merged[key].get(field), row.get(field)
                    merged[key][field] = a + b if a is not None and b is not None else None
        rows = list(merged.values())
    field = "allocationPct" if dimension == "company" else "valueGbp"
    return sorted(rows, key=lambda row: row.get(field) or 0, reverse=True)


def retained_dates(days: list[date]) -> set[date]:
    if not days:
        return set()
    latest = max(days)
    monthly = {(day.year, day.month): day for day in sorted(days)}
    return {day for day in days if day > latest - timedelta(days=RECENT_DAYS)} | {
        day
        for (year, month), day in monthly.items()
        if (latest.year - year) * 12 + latest.month - month < RETAIN_MONTHS
    }


def record_exposure(
    artifacts: ContentAddressedArtifactStore, refs: dict[str, ArtifactRef], current: ArtifactRef
) -> None:
    """Pin one published composition per London day using the existing immutable blob."""
    raw = artifacts.get_json(current.artifact_id).payload
    stamp = raw.get("brokerAsOf")
    if raw.get("available") is not True or not stamp:
        return
    try:
        observed = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return
    if observed.tzinfo is None:
        return
    day = observed.astimezone(ZoneInfo("Europe/London")).date()
    key = f"{PREFIX}{day.isoformat()}.json"
    if key in refs:
        return
    # Manifest keys are lookup names. The digest continues to identify the
    # original look-through envelope, so even a retained snapshot or backup
    # adds no duplicate dated blobs and never needs cross-store deletion.
    refs[key] = current.model_copy(update={"key": key})
    dated = {date.fromisoformat(k[len(PREFIX) : -5]): k for k in refs if k.startswith(PREFIX)}
    for expired in dated.keys() - retained_dates(list(dated)):
        del refs[dated[expired]]
