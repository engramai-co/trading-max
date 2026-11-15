"""Public market observations and private, snapshot-scoped tracking exposure."""

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request
from trading_max.reference.indices import IndexRange, IndexScope, IndexSpec

from ..global_sector_models import GlobalSectorBoard
from ..index_models import (
    GlobalMarketContribution,
    IndexContext,
    IndexHistory,
    IndexIdentity,
    IndexLens,
    IndexMarket,
    IndexResearch,
)
from ..index_research import index_research
from ..indices import active_indices
from .dependencies import app_service

router = APIRouter(tags=["indices"])
IndexId = Annotated[str, Path(min_length=1, max_length=60, pattern=r"^[a-z0-9-]+$")]


def _find(index_id: str) -> IndexSpec:
    spec = next((item for item in active_indices() if item.id == index_id), None)
    if spec is None:
        raise HTTPException(status_code=404, detail="Unknown index")
    return spec


@router.get("/v1/indices/catalog", response_model=list[IndexIdentity])
def index_catalog(request: Request) -> list[IndexIdentity]:
    return app_service(request, "indices").catalog()


@router.get("/v1/indices", response_model=IndexMarket)
def index_market(request: Request, scope: IndexScope) -> IndexMarket:
    return app_service(request, "indices").market(scope)


@router.get("/v1/indices/global-contribution", response_model=GlobalMarketContribution)
def global_contribution(request: Request) -> GlobalMarketContribution:
    return app_service(request, "indices").global_contribution()


@router.get("/v1/indices/global-sectors", response_model=GlobalSectorBoard)
def global_sectors(request: Request) -> GlobalSectorBoard:
    return app_service(request, "indices").global_sectors()


@router.get("/v1/indices/{index_id}/history", response_model=IndexHistory)
def index_history(
    request: Request,
    index_id: IndexId,
    period: Annotated[IndexRange, Query(alias="range")] = "1Y",
    currency: Literal["local", "GBP"] = "local",
) -> IndexHistory:
    return app_service(request, "indices").history(_find(index_id), period, currency == "GBP")


@router.get("/v1/indices/{index_id}/context", response_model=IndexContext)
def index_context(request: Request, index_id: IndexId) -> IndexContext:
    context = app_service(request, "indices").context(_find(index_id))
    if context.basket is not None:
        context.basket = context.basket.model_copy(update={"members": []})
    return context


@router.get("/v1/indices/{index_id}/research", response_model=IndexResearch)
def research_index(
    request: Request, index_id: IndexId, view: IndexLens = "overview"
) -> IndexResearch:
    return index_research(app_service(request, "indices"), _find(index_id), view)
