"""Deterministic attribution of a global move to public index observations."""

from collections.abc import Mapping
from math import fsum
from typing import get_args

from trading_max.infrastructure.acwi_weights import AcwiWeights

from .index_models import (
    GlobalContributionRow,
    GlobalMapMarket,
    GlobalMarketContribution,
    GlobalMarketMove,
    GlobalRowMarket,
    IndexQuote,
)

MAIN_INDEX: dict[GlobalMapMarket, str] = {
    "us": "sp-500",
    "ca": "sp-tsx",
    "uk": "ftse-100",
    "eu": "stoxx-europe-600",
    "ch": "smi",
    "jp": "nikkei-225",
    "au": "asx-200",
    "hk": "hang-seng",
    "kr": "kospi",
    "tw": "taiex",
    "in": "nifty-50",
}
EUROPE = frozenset(
    [
        "Austria",
        "Belgium",
        "Denmark",
        "Finland",
        "France",
        "Germany",
        "Ireland",
        "Italy",
        "Netherlands",
        "Norway",
        "Portugal",
        "Spain",
        "Sweden",
    ]
)
# MSCI market classification: Hong Kong is developed; Korea and Taiwan are emerging.
EMERGING = frozenset(
    {
        "Brazil",
        "Chile",
        "China",
        "Colombia",
        "Czech Republic",
        "Egypt",
        "Greece",
        "Hungary",
        "India",
        "Indonesia",
        "Korea (South)",
        "South Korea",
        "Kuwait",
        "Malaysia",
        "Mexico",
        "Peru",
        "Philippines",
        "Poland",
        "Qatar",
        "Saudi Arabia",
        "South Africa",
        "Taiwan",
        "Thailand",
        "Turkey",
        "United Arab Emirates",
    }
)
LOCATIONS: dict[GlobalRowMarket, frozenset[str]] = {
    "us": frozenset({"United States"}),
    "ca": frozenset({"Canada"}),
    "uk": frozenset({"United Kingdom"}),
    "eu": EUROPE,
    "ch": frozenset({"Switzerland"}),
    "jp": frozenset({"Japan"}),
    "au": frozenset({"Australia"}),
    "hk": frozenset({"Hong Kong"}),
    "em": EMERGING,
}


def estimate_contribution(
    acwi: IndexQuote | None,
    weights: AcwiWeights | None,
    weights_stale: bool,
    market_moves: Mapping[GlobalMapMarket, float | None],
    em_move: float | None,
) -> GlobalMarketContribution:
    total = acwi.change if acwi else None
    markets = [
        GlobalMarketMove(market=market, move=market_moves.get(market)) for market in MAIN_INDEX
    ]
    rows: list[GlobalContributionRow] = []
    residual = None
    state = "unavailable"
    if total is not None and weights is not None:
        partial = any(item.move is None for item in markets)
        for market in get_args(GlobalRowMarket):
            share = fsum(
                weight
                for location, weight in weights.locations.items()
                if location in LOCATIONS[market]
            )
            move = em_move if market == "em" else market_moves.get(market)
            if not share:
                continue
            if move is None:
                partial = True
                continue
            rows.append(
                GlobalContributionRow(
                    market=market,
                    index_id="msci-em" if market == "em" else MAIN_INDEX[market],
                    weight=share,
                    move=move,
                    contribution=share * move,
                )
            )
        # Rank by impact so the largest movers lead regardless of direction.
        rows.sort(key=lambda row: (-abs(row.contribution), row.market))
        residual = total - fsum(row.contribution for row in rows)
        state = "partial" if partial else "ready"
    return GlobalMarketContribution(
        acwi_move=total,
        as_of=acwi.as_of if acwi else None,
        weights_as_of=weights.as_of if weights else None,
        weights_stale=weights_stale,
        markets=markets,
        rows=rows,
        residual=residual,
        state=state,
    )
