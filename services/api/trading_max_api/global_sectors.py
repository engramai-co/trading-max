"""Compare official MSCI World sector index observations on the Global reference clock."""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from math import isfinite

from trading_max.infrastructure.sector_prices import SparkSeries
from trading_max.infrastructure.sector_universe import GICS_SECTORS, SECTOR_ALIASES
from trading_max.infrastructure.shared_market_prices import SharedMarketPrices
from trading_max.infrastructure.world_sector_weights import WorldSectorWeights
from trading_max.reference.msci_world_sectors import WORLD_INDUSTRY_INDICES, WorldIndustryIndex

from .artifacts import ArtifactStore
from .global_markets import MSCI_ZONE, GlobalReference, Reference, _points, benchmark_closes
from .global_sector_models import (
    GlobalIndustryMove,
    GlobalSectorBoard,
    GlobalSectorHolding,
    GlobalSectorMove,
    GlobalSectorPoint,
)
from .sector_context import LOOKTHROUGH_KEY

LOGGER = logging.getLogger(__name__)
SECTORS = tuple(item for item in WORLD_INDUSTRY_INDICES if item.level == "sector")
GROUPS = tuple(item for item in WORLD_INDUSTRY_INDICES if item.level == "group")
MAX_LAG = timedelta(minutes=45)


def _daily(series: SparkSeries | None, now: datetime) -> dict[date, float]:
    return {
        at.astimezone(MSCI_ZONE).date(): value
        for at, value in _points(series, now)
        if at.astimezone(MSCI_ZONE).weekday() < 5
    }


def _official_closes(
    intraday: SparkSeries | None, daily: SparkSeries | None, now: datetime, reference: Reference
) -> dict[date, float]:
    # Today's daily bar can still be an indicative level. Earlier bars on the
    # reference clock are settled; an absent daily series (e.g. Real Estate)
    # can corroborate closes using the feed's carried official marks.
    lower = reference.start.astimezone(MSCI_ZONE).date()
    settled = {day: value for day, value in _daily(daily, now).items() if day <= lower}
    for day, (at, value) in benchmark_closes(intraday, daily, now).items():
        if at <= reference.as_of and day <= reference.date:
            settled.setdefault(day, value)
    if reference.phase == "completed" and reference.date not in settled:
        # A daily bar corroborates the published closing level when the
        # same index mark is observed near the Global closing boundary.
        close = _daily(daily, now).get(reference.date)
        if close and any(
            abs(value - close) <= 0.0005 and reference.as_of - MAX_LAG <= at <= reference.as_of
            for at, value in _points(intraday, reference.as_of)
        ):
            settled[reference.date] = close
    return settled


def _reading(
    intraday: SparkSeries | None,
    daily: SparkSeries | None,
    now: datetime,
    reference: Reference,
    opened: datetime,
) -> tuple[float | None, list[GlobalSectorPoint], dict[date, float]]:
    closes = _official_closes(intraday, daily, now, reference)
    prior_day = reference.start.astimezone(MSCI_ZONE).date()
    base = closes.get(prior_day)
    if base is None and reference.phase == "live" and intraday and intraday.previous_close:
        previous = intraday.previous_close
        if any(
            at.astimezone(MSCI_ZONE).date() == prior_day and abs(value - previous) <= 0.0005
            for at, value in _points(intraday, reference.start)
        ):
            base = previous
    observations = [(at, value) for at, value in _points(intraday, reference.as_of) if at >= opened]
    if reference.phase == "completed":
        level = closes.get(reference.date)
    else:
        last = observations[-1] if observations else None
        level = last[1] if last and last[0] >= reference.as_of - MAX_LAG else None
    move = level / base - 1 if level and base else None
    line = []
    if move is not None and base and intraday:
        line = [
            GlobalSectorPoint(at=at, move=value / base - 1 if value is not None else None)
            for stamp, value in zip(intraday.timestamps, intraday.closes, strict=False)
            if opened <= (at := datetime.fromtimestamp(stamp, UTC)) <= reference.as_of
        ]
    return move, line, closes


def _ranks(
    dates: list[date], closes: Mapping[str, Mapping[date, float]]
) -> tuple[list[date], dict[str, list[int | None]]]:
    results: dict[str, list[int | None]] = {key: [] for key in closes}
    for prior, day in pairwise(dates):
        moves = {
            key: values[day] / values[prior] - 1
            for key, values in closes.items()
            if prior in values and day in values
        }
        ordered = sorted(moves, key=lambda key: (-moves[key], key))
        for key, ranks in results.items():
            ranks.append(ordered.index(key) + 1 if key in moves else None)
    return dates[1:], results


def _index_fields(spec: WorldIndustryIndex, move: float | None) -> dict:
    return {
        "gics": spec.gics,
        "index_code": spec.code,
        "name": spec.name,
        "move": move,
    }


def read_global_sectors(
    prices: SharedMarketPrices,
    weights: WorldSectorWeights | None,
    weights_stale: bool,
    now: datetime,
    clock: GlobalReference,
) -> GlobalSectorBoard:
    reference = clock.reference
    moves: dict[str, float | None] = {}
    lines: dict[str, list[GlobalSectorPoint]] = {}
    dates: list[date] = []
    ranks: dict[str, list[int | None]] = {}
    if reference:
        symbols = [spec.symbol for spec in WORLD_INDUSTRY_INDICES if spec.symbol]
        # For live groups a dated prior daily mark is sufficient; all sectors
        # need daily observations for the rank strip. The same batched
        # five-minute feed covers both the live and last completed session.
        daily, intraday = {}, {}
        try:
            daily = prices.daily(symbols)
        except Exception:
            LOGGER.debug("World sector daily prices failed", exc_info=True)
        try:
            intraday = prices.benchmark_intraday_batch(symbols)
        except Exception:
            LOGGER.debug("World sector five-minute prices failed", exc_info=True)
        opened = min(
            (
                window.open
                for windows in clock.sessions.values()
                for window in windows or ()
                if reference.start < window.open <= reference.end
            ),
            default=reference.start,
        )
        # Yahoo's spark stream drops the carried marks. Use chart only for
        # the exceptional series with no dated daily history (Real Estate
        # and Semiconductors). Sector ranks need six completed closes.
        for spec in WORLD_INDUSTRY_INDICES:
            symbol = spec.symbol
            if not symbol or symbol not in intraday or len(_daily(daily.get(symbol), now)) >= 7:
                continue
            try:
                carried = prices.benchmark_intraday(symbol, extended=spec.level == "sector")
            except Exception:
                LOGGER.debug("World industry close history failed", exc_info=True)
            else:
                if carried:
                    intraday[symbol] = carried
        closes = {}
        for spec in WORLD_INDUSTRY_INDICES:
            symbol = spec.symbol or ""
            move, line, values = _reading(
                intraday.get(symbol), daily.get(symbol), now, reference, opened
            )
            moves[spec.gics] = move
            if spec.level == "sector":
                closes[spec.gics] = values
                lines[spec.gics] = line
        last_complete = (
            reference.date
            if reference.phase == "completed"
            else reference.start.astimezone(MSCI_ZONE).date()
        )
        sessions = [day for day in sorted(_daily(clock.daily, now)) if day <= last_complete][-6:]
        dates, ranks = _ranks(sessions, closes)

    sectors = []
    for spec in SECTORS:
        move = moves.get(spec.gics)
        row = weights.sectors.get(spec.gics) if weights else None
        groups = [
            GlobalIndustryMove(**_index_fields(group, moves.get(group.gics)))
            for group in GROUPS
            if group.gics.startswith(spec.gics)
        ]
        groups.sort(key=lambda group: (group.move is None, -(group.move or 0), group.gics))
        sectors.append(
            GlobalSectorMove(
                **_index_fields(spec, move),
                weight=row.weight if row else None,
                contribution=row.weight * move if row and move is not None else None,
                intraday=lines.get(spec.gics, []),
                ranks=ranks.get(spec.gics, []),
                groups=groups,
                holdings=[
                    GlobalSectorHolding(name=item.name, weight=item.weight) for item in row.holdings
                ]
                if row
                else [],
            )
        )
    return GlobalSectorBoard(
        reference_date=reference.date if reference else None,
        phase=reference.phase if reference else None,
        as_of=reference.as_of if reference else None,
        acwi_move=reference.move if reference else None,
        acwi_level=reference.level if reference else None,
        weights_as_of=weights.as_of if weights else None,
        weights_stale=weights_stale,
        prices_stale=clock.prices_stale,
        rank_sessions=dates,
        sectors=sectors,
    )


def with_portfolio_exposure(board: GlobalSectorBoard, store: ArtifactStore) -> GlobalSectorBoard:
    """Read the existing all-account sector allocation from the current immutable snapshot."""
    try:
        manifest = store.latest_manifest()
        data = store.read_json(manifest.run_id, LOOKTHROUGH_KEY) if manifest else None
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        return board
    if not isinstance(data, dict):
        return board
    basis = _positive(data.get("investedValueGbp"))
    rows = data.get("industryAllocation")
    if basis is None or not isinstance(rows, list):
        return board
    amounts: defaultdict[str, float] = defaultdict(float)
    for row in rows:
        if not isinstance(row, dict) or row.get("isNonIndustry"):
            continue
        name = str(row.get("industry") or "")
        sector = GICS_SECTORS.get(SECTOR_ALIASES.get(name, name))
        value = _positive(row.get("valueGbp"))
        if sector and value is not None:
            amounts[sector] += value
    if not amounts:
        return board
    return board.model_copy(
        update={
            "exposure_basis_gbp": basis,
            "sectors": [
                sector.model_copy(update={"exposure_gbp": amounts.get(sector.gics)})
                for sector in board.sectors
            ],
        }
    )


def _positive(value: object) -> float | None:
    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and isfinite(value)
        and value > 0
    ):
        return float(value)
    return None
