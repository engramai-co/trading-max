"""Expose the sector boards: how far each sector of a market has moved today."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request

from ..sector_models import SectorBoardResponse, SectorMarketCode
from .dependencies import app_service

router = APIRouter(tags=["sectors"])


@router.get("/v1/sectors", response_model=SectorBoardResponse)
def sector_board(
    request: Request,
    market: Annotated[
        SectorMarketCode | None,
        Query(description="Market to show; defaults to the one trading now."),
    ] = None,
) -> SectorBoardResponse:
    return app_service(request, "sector_monitor").response(market)
