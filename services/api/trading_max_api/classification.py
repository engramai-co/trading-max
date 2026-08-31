"""API adapters for the shared versioned classification service.

Company assignments are profile-driven.  This module intentionally contains
no ticker whitelist; the backend reference package owns the taxonomy and
provider-profile crosswalk used by both API and portfolio jobs.
"""

from __future__ import annotations

from typing import Any

from trading_max.reference import (
    classification_for_code as domain_classification_for_code,
)
from trading_max.reference import (
    classification_for_profile as domain_classification_for_profile,
)
from trading_max.reference import gics_node_for_code

from .models import GicsClassification, WatchlistCategory

UNCLASSIFIED_CATEGORY_ID = "gics-unclassified"


def category_id_for_code(code: str) -> str:
    return f"gics-{code}"


def _api_classification(value: Any) -> GicsClassification | None:
    if value is None:
        return None
    return GicsClassification.model_validate(value.model_dump(mode="json", by_alias=True))


def classification_for_code(
    code: str,
    *,
    source: str,
) -> GicsClassification | None:
    return _api_classification(
        domain_classification_for_code(
            code,
            source=source,
            method="derived",
        )
    )


def classification_for_profile(
    ticker: str,
    sector: str | None,
    industry: str | None,
) -> GicsClassification | None:
    # ``ticker`` stays in the public signature for compatibility, but is
    # deliberately ignored: business metadata, never identity, drives GICS.
    del ticker
    return _api_classification(
        domain_classification_for_profile(
            sector=sector,
            industry=industry,
            industry_key=industry,
        )
    )


def category_for_classification(
    classification: GicsClassification,
    *,
    order: int,
) -> WatchlistCategory:
    node = gics_node_for_code(classification.sub_industry_code)
    if node is None:
        raise ValueError(f"unknown configured GICS node: {classification.sub_industry_code}")
    parent = (
        f"{classification.sector_name} / "
        f"{classification.industry_group_name} / "
        f"{classification.industry_name}"
    )
    return WatchlistCategory(
        id=category_id_for_code(classification.sub_industry_code),
        label_zh=node.label_zh,
        label_en=classification.sub_industry_name,
        description_zh=f"GICS {classification.sub_industry_code} · {parent}",
        description_en=f"GICS {classification.sub_industry_code} · {parent}",
        order=order,
        taxonomy="gics-sub-industry",
        code=classification.sub_industry_code,
    )


def unclassified_category(*, order: int = 999) -> WatchlistCategory:
    return WatchlistCategory(
        id=UNCLASSIFIED_CATEGORY_ID,
        label_zh="待确认分类",
        label_en="Unclassified",
        description_zh="等待公司业务资料足够后映射到 GICS Sub-Industry",
        description_en="Awaiting sufficient company metadata for GICS mapping",
        order=order,
        taxonomy="gics-sub-industry",
    )


def market_profile(row: dict[str, Any]) -> tuple[str | None, str | None]:
    sector = row.get("profile_sector") or row.get("sector")
    industry = row.get("profile_industry") or row.get("industry")
    return (
        str(sector).strip() if sector else None,
        str(industry).strip() if industry else None,
    )


__all__ = [
    "UNCLASSIFIED_CATEGORY_ID",
    "category_for_classification",
    "category_id_for_code",
    "classification_for_code",
    "classification_for_profile",
    "market_profile",
    "unclassified_category",
]
