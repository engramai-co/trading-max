"""Typed World sector observations and look-through exposure."""

from datetime import date, datetime
from typing import Literal

from .models import ApiModel


class GlobalIndustryMove(ApiModel):
    gics: str
    index_code: int | None
    name: str
    move: float | None


class GlobalSectorPoint(ApiModel):
    at: datetime
    move: float | None


class GlobalSectorHolding(ApiModel):
    name: str
    weight: float


class GlobalSectorMove(GlobalIndustryMove):
    weight: float | None
    contribution: float | None
    intraday: list[GlobalSectorPoint]
    ranks: list[int | None]
    groups: list[GlobalIndustryMove]
    holdings: list[GlobalSectorHolding]
    exposure_gbp: float | None = None


class GlobalSectorBoard(ApiModel):
    reference_date: date | None
    phase: Literal["live", "completed"] | None
    as_of: datetime | None
    acwi_move: float | None
    acwi_level: float | None
    weights_as_of: date | None
    weights_stale: bool
    rank_sessions: list[date]
    exposure_basis_gbp: float | None = None
    sectors: list[GlobalSectorMove]
