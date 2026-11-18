"""Snapshot-pinned readings for portfolio and research inspection."""

from dataclasses import replace
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict
from pydantic_ai import ModelRetry

from ..agent import insights
from ..agent.deps import AssistantDeps

router = APIRouter(prefix="/v1/snapshots/{run_id}/insights", tags=["insights"])


class Page[T](BaseModel):
    items: list[T]
    total_items: int
    next_cursor: int | None


class Source(BaseModel):
    source_id: str
    as_of: str | None


class Quality(BaseModel):
    issues: list[str]
    reason_code: str | None = None


class Reading[T](BaseModel):
    status: Literal["ok", "partial", "unavailable", "not_applicable"]
    data: T | None
    snapshot_id: str
    scope: str
    sources: list[Source]
    quality: Quality
    evidence_id: str


class DailyReturn(BaseModel):
    date: str
    from_date: str
    return_fraction: float
    worst_rank: int
    benchmark_return_fractions: dict[str, float | None]


class DailyReturns(Page[DailyReturn]):
    currency: str
    basis: str
    range: str
    window_start: str
    window_end: str
    window_twr_fraction: float | None
    window_benchmarks: dict[str, float]
    observed_intervals: int
    total_intervals: int
    largest_move: DailyReturn
    worst_day: DailyReturn
    benchmark: str
    benchmark_currency: str | None
    benchmark_basis: str | None


class Effects(BaseModel):
    contribution_gbp: float | None
    local_price_effect_gbp: float | None
    fx_effect_gbp: float | None


class PositionEffects(Effects):
    ticker: str | None
    instrument: str | None
    scope: str


class AccountEffects(Effects):
    since: str | None
    as_of: str | None


class FXSplit(Page[PositionEffects]):
    currency: str
    period: str
    accounts: dict[str, AccountEffects]


class ExposureRow(BaseModel):
    entity_id: str | None = None
    name: str | None
    value_gbp: float | None
    weight_fraction: float | None
    ticker: str | None = None
    isin: str | None = None
    code: str | None = None
    classification_status: str | None = None


class ExposureStart(BaseModel):
    history_available_from: str


class DatedExposure(Page[ExposureRow], ExposureStart):
    requested_date: str
    observation_date: str
    broker_as_of: str | None
    currency: str
    dimension: str
    basis: str | None
    gics_coverage_fraction: float | None = None
    gics_portfolio_coverage_fraction: float | None = None
    lookthrough_coverage_fraction: float | None
    invested_value_gbp: float | None
    company_table_truncated: bool
    company_limit: int | None


class Timing(BaseModel):
    best_date: str | None
    window_end: str | None
    best_close_gbp: float | None
    average_order_gbp: float | None
    missed_gbp: float | None


class DecisionTiming(BaseModel):
    scope: str
    ticker: str
    date: str
    side: str
    horizon: str
    observed_days: int | None
    effect_gbp: float | None
    hindsight: Timing | None


class Habit(BaseModel):
    side: str
    decisions: int
    evaluated: int
    favourable: int
    adverse: int
    unchanged: int
    favourable_fraction: float | None
    effect_gbp: float | None


class ReviewTiming(Page[DecisionTiming]):
    currency: str
    horizon: str
    as_of: dict[str, str | None]
    order_size_basis: str
    habits: list[Habit]


class MomentEvent(BaseModel):
    date: str
    kind: str
    reference: str
    publication_date: str | None = None
    timing: Literal["closing_auction_window"] | None = None
    role: Literal["lead"] | None = None


class Moment(BaseModel):
    date: str
    move_fraction: float | None
    volume_z_score: float | None
    unusual_rank: int
    events: list[MomentEvent]
    event_count: int


class PriceMoments(BaseModel):
    ticker: str
    start: str
    end: str
    interval: str
    basis: str
    published_series_id: str
    items: list[Moment]


# Query strings serialise integers as text. The assistant's JSON arguments stay strict.
class DailyQuery(insights.DailyArgs):
    model_config = ConfigDict(strict=False)


class FxQuery(insights.FXArgs):
    model_config = ConfigDict(strict=False)


class ExposureQuery(insights.ExposureHistoryArgs):
    model_config = ConfigDict(strict=False)


class ReviewQuery(insights.ReviewArgs):
    model_config = ConfigDict(strict=False)


def _deps(
    request: Request, run_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,100}$")]
) -> AssistantDeps:
    deps = request.app.state.assistant.deps_for_run(None, None)
    try:
        manifest = deps.store.load_manifest(run_id)
    except FileNotFoundError:
        raise HTTPException(404, "snapshot not found") from None
    return replace(deps, manifest=manifest)


Bound = Annotated[AssistantDeps, Depends(_deps)]


def _project(project, deps, args):
    try:
        return project(deps, args)
    except ModelRetry as error:
        raise HTTPException(422, str(error)) from None


@router.get(
    "/daily-returns", response_model=Reading[DailyReturns], response_model_exclude_unset=True
)
def daily_returns(args: Annotated[DailyQuery, Query()], deps: Bound):
    return _project(insights.daily_data, deps, args)


@router.get("/holding-fx", response_model=Reading[FXSplit], response_model_exclude_unset=True)
def holding_fx(args: Annotated[FxQuery, Query()], deps: Bound):
    return _project(insights.fx_data, deps, args)


@router.get(
    "/dated-exposure",
    response_model=Reading[DatedExposure | ExposureStart],
    response_model_exclude_unset=True,
)
def dated_exposure(args: Annotated[ExposureQuery, Query()], deps: Bound):
    return _project(insights.exposure_data, deps, args)


@router.get(
    "/decision-timing", response_model=Reading[ReviewTiming], response_model_exclude_unset=True
)
def decision_timing(args: Annotated[ReviewQuery, Query()], deps: Bound):
    return _project(insights.review_data, deps, args)


@router.get("/key-moments", response_model=Reading[PriceMoments], response_model_exclude_unset=True)
def key_moments(args: Annotated[insights.MomentsArgs, Query()], deps: Bound):
    return _project(insights.moments_data, deps, args)
