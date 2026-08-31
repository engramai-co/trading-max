"""Stable logical identities for snapshot-bound model analysis."""

from __future__ import annotations

from typing import cast

from .models import AnalysisLens, AnalysisPage

ANALYSIS_LENS_BY_PAGE: dict[AnalysisPage, AnalysisLens] = {
    "overview": "daily_cio_brief",
    "holdings": "hidden_exposure",
    "analytics": "return_attribution",
    "research": "watchlist_opportunity_map",
    "technical": "technical_regime",
    "valuation": "valuation_scenario",
    "fundamentals": "fundamental_health",
    "analyst": "analyst_consensus",
    "financials": "financial_statements",
    "options": "options_positioning",
    "ledger": "thesis_change",
}

ANALYSIS_PAGE_BY_LENS: dict[AnalysisLens, AnalysisPage] = {
    lens: page for page, lens in ANALYSIS_LENS_BY_PAGE.items()
}


def lens_for_page(page: AnalysisPage) -> AnalysisLens:
    """Return the stable lens represented by a legacy presentation page."""

    return ANALYSIS_LENS_BY_PAGE[page]


def page_for_lens(lens: AnalysisLens) -> AnalysisPage:
    """Return legacy page metadata for compatibility with pre-lens clients."""

    return ANALYSIS_PAGE_BY_LENS[lens]


def normalize_lens(value: str) -> AnalysisLens:
    """Normalize persisted pre-lens page keys without losing run history."""

    if value in ANALYSIS_LENS_BY_PAGE:
        return ANALYSIS_LENS_BY_PAGE[cast(AnalysisPage, value)]
    if value in ANALYSIS_PAGE_BY_LENS:
        return cast(AnalysisLens, value)
    raise ValueError(f"unknown analysis lens: {value}")


__all__ = [
    "ANALYSIS_LENS_BY_PAGE",
    "ANALYSIS_PAGE_BY_LENS",
    "lens_for_page",
    "normalize_lens",
    "page_for_lens",
]
