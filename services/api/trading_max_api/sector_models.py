"""Typed sector-board contract: how far each sector of one market has moved today.

A board covers one market's broad index universe (constituents and weights from
an issuer's published ETF holdings, prices from the market-data provider). Every
figure is a fraction of the previous session's close (0.0145 is +1.45%); weights
are fractions of the grouping's whole universe. Exposure is the owner's
look-through value in the same constituents, matched by security identifier.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from .models import ApiModel, SectorMonitorState

SectorMarketCode = Literal["us", "uk", "hk", "kr", "jp"]
SectorGroupingKind = Literal["gics", "themes"]


class SectorSessionWindow(ApiModel):
    """One regular session as the exchange schedules it, in UTC."""

    date: str
    open: datetime
    close: datetime
    break_start: datetime | None = None
    break_end: datetime | None = None


class SectorBreadth(ApiModel):
    """Members up, unchanged (within ±0.05%) and down on the session."""

    up: int = 0
    flat: int = 0
    down: int = 0


class SectorLeader(ApiModel):
    symbol: str
    name: str
    change: float


class SectorMember(ApiModel):
    symbol: str = Field(description="Provider symbol, for example AAPL, HSBA.L, 0700.HK.")
    name: str
    subgroup: str = Field(
        default="",
        description="GICS industry-group code; empty for themes or an unclassified member.",
    )
    change: float | None = None
    weight: float = 0.0
    exposure_gbp: float = 0.0
    research_ticker: str | None = Field(
        default=None,
        description="The research desk ticker when the research universe covers this member.",
    )


class SectorSubgroup(ApiModel):
    """A GICS industry group inside one sector."""

    key: str
    name: str
    change: float | None = None
    weight: float = 0.0
    breadth: SectorBreadth = Field(default_factory=SectorBreadth)
    member_count: int = 0
    exposure_gbp: float = 0.0


class SectorGroup(ApiModel):
    key: str = Field(description="GICS sector code or research theme id.")
    name: str = Field(description="English GICS sector name or theme label.")
    name_zh: str | None = Field(
        default=None,
        description="A theme's own Chinese label; GICS names are translated by the client.",
    )
    change: float | None = None
    weight: float = 0.0
    breadth: SectorBreadth = Field(default_factory=SectorBreadth)
    member_count: int = 0
    leader: SectorLeader | None = None
    path: list[float | None] = Field(
        default_factory=list,
        description="Session change at each of the board's times.",
    )
    ranks: list[int | None] = Field(
        default_factory=list,
        description="Rank among the grouping's groups for each of the board's rank sessions.",
    )
    streak: int = Field(
        default=0,
        description="Consecutive latest sessions ranked within the top three.",
    )
    exposure_gbp: float = 0.0
    subgroups: list[SectorSubgroup] = Field(default_factory=list)
    members: list[SectorMember] = Field(default_factory=list)


class SectorGrouping(ApiModel):
    kind: SectorGroupingKind
    groups: list[SectorGroup] = Field(default_factory=list)


class SectorSource(ApiModel):
    universe: str = Field(description="Index universe, for example S&P 500.")
    fund: str
    fund_ticker: str
    url: str
    as_of: str = Field(description="The issuer's holdings date.")
    prices: str = "Yahoo Finance"


class SectorBoard(ApiModel):
    market: SectorMarketCode
    session_date: str
    complete: bool = Field(description="The session closed and its final bars were captured.")
    as_of: datetime | None = Field(
        default=None,
        description="End of the latest price bar included.",
    )
    fetched_at: datetime
    times: list[datetime] = Field(default_factory=list)
    rank_sessions: list[str] = Field(default_factory=list)
    member_count: int = 0
    priced_count: int = 0
    source: SectorSource
    exposure_gbp: float = 0.0
    exposure_basis_gbp: float | None = Field(
        default=None,
        description="Invested value of the look-through the exposure was matched against.",
    )
    groupings: list[SectorGrouping] = Field(default_factory=list)


class SectorMarketStatus(ApiModel):
    market: SectorMarketCode
    calendar: str
    timezone: str
    sessions: list[SectorSessionWindow] = Field(default_factory=list)
    session_date: str | None = None
    complete: bool = False
    as_of: datetime | None = None
    fetched_at: datetime | None = None
    exposure_gbp: float = 0.0
    last_error: str | None = None
    last_error_at: datetime | None = None


class SectorBoardResponse(ApiModel):
    market: SectorMarketCode
    markets: list[SectorMarketStatus] = Field(default_factory=list)
    board: SectorBoard | None = None
    monitor: SectorMonitorState | None = Field(
        default=None,
        description="Refresh schedule, so an empty board can say when the next update runs.",
    )


__all__ = [
    "SectorBoard",
    "SectorBoardResponse",
    "SectorBreadth",
    "SectorGroup",
    "SectorGrouping",
    "SectorGroupingKind",
    "SectorLeader",
    "SectorMarketCode",
    "SectorMarketStatus",
    "SectorMember",
    "SectorMonitorState",
    "SectorSessionWindow",
    "SectorSource",
    "SectorSubgroup",
]
