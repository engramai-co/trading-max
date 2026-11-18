"""Explain a selected, published look-through allocation and its dated comparators."""

from datetime import datetime, timedelta
from typing import Literal

from pydantic import Field
from trading_max.analytics.exposure_history import _countries
from trading_max.infrastructure.acwi_weights import AcwiWeights
from trading_max.infrastructure.sector_universe import GICS_SECTORS, SECTOR_ALIASES
from trading_max.infrastructure.world_sector_weights import WorldSectorWeights

from . import insights, tools
from .overview_roles import LONDON, line
from .roles import PageRole, RoleContext, RoleTools


class ExposureContext(RoleContext):
    dimension: Literal["country", "sector", "gics", "company"]
    category: str = Field(min_length=1, max_length=180)


def _category(dimension, row):
    if dimension == "country":
        return _countries().get((row["name"] or "").lower(), row["name"])
    if dimension == "company":
        return row.get("isin") or row.get("ticker") or row["name"]
    return row["name"]


def _find(read, tool, args, context):
    while True:
        result = read.read(tool, args)
        data = result.get("data") or {}
        for row in data.get("items", []):
            expected = (
                _countries().get(context.category.lower(), context.category)
                if context.dimension == "country"
                else context.category
            )
            if _category(context.dimension, row) == expected:
                return row, result
        cursor = data.get("next_cursor")
        if cursor is None:
            return None, result
        args = args.model_copy(update={"cursor": cursor})


def exposure_benchmark(ctx: tools.Context, args: ExposureContext):
    """The dated fund weight matching the selected portfolio country or GICS sector."""
    read = tools._Read(ctx.deps, "exposure_benchmark", args, "broker_total")
    read.account_codes("broker_total")
    source = ctx.deps.page_sources
    weights = (
        source.weights(args.dimension)
        if source and args.dimension in {"country", "sector"}
        else None
    )
    value = None
    if isinstance(weights, AcwiWeights):
        codes = _countries()
        code = codes.get(args.category.lower(), args.category)
        matched = [
            weight
            for name, weight in weights.locations.items()
            if codes.get(name.lower(), name) == code
        ]
        value = sum(matched) if matched else None
    elif isinstance(weights, WorldSectorWeights):
        code = GICS_SECTORS.get(SECTOR_ALIASES.get(args.category, args.category))
        value = weights.sectors[code].weight if code in weights.sectors else None
    if (
        value is None
        or not ctx.deps.manifest
        or weights.as_of > ctx.deps.manifest.created_at.date()
    ):
        return read.missing("dated_benchmark_weight_unavailable")
    return read.result(data={"as_of": weights.as_of.isoformat(), "weight": value})


def exposure_version(read: RoleTools, context: ExposureContext):
    benchmark = read.read(exposure_benchmark, context)
    return tools._short_id("exposure_", [read.deps.snapshot_id, benchmark.get("data")])


def exposure_facts(read: RoleTools, context: ExposureContext):
    args = {"scope": "broker_total", "dimension": context.dimension, "limit": 20}
    item, current = _find(read, tools.lookthrough_exposure, tools.ExposureArgs(**args), context)
    data = current.get("data") or {}
    if not item or item["weight_fraction"] is None or not data.get("broker_as_of"):
        return []
    day = datetime.fromisoformat(data["broker_as_of"]).astimezone(LONDON).date()
    arguments = {
        "dimension": context.dimension,
        "category": context.category,
        "snapshotId": read.deps.snapshot_id,
    }

    def observation(section, zh, en, result=current, tool="lookthrough_exposure"):
        return line(section, zh, en, result, "exposure", tool, metric=section, **arguments)

    weight = item["weight_fraction"]
    facts = [
        observation(
            "current",
            f"{day}，占已投资资产的 {weight:.2%}。",
            f"On {day}, this accounted for {weight:.2%} of invested assets.",
        )
    ]
    cutoff = (day - timedelta(days=30)).isoformat()
    prior, history = _find(
        read,
        insights.dated_exposure,
        insights.ExposureHistoryArgs(**args, on_or_before=cutoff),
        context,
    )
    if prior and prior["weight_fraction"] is not None:
        stamp = history["data"]["observation_date"]
        previous = prior["weight_fraction"]
        facts.append(
            observation(
                "history",
                f"{stamp} 占比 {previous:.2%}，此后变化 {(weight - previous) * 100:+.2f} 个百分点。",
                f"The weight was {previous:.2%} on {stamp}, a change of {(weight - previous) * 100:+.2f} pp since then.",
                history,
                "dated_exposure",
            )
        )
    else:
        facts.append(
            observation(
                "history",
                f"{cutoff} 或之前暂无这项分类的可比记录。",
                f"No comparable weight is recorded on or before {cutoff}.",
                history,
                "dated_exposure",
            )
        )
    if context.dimension in {"country", "sector"}:
        result = read.read(exposure_benchmark, context)
        benchmark = "MSCI ACWI (SSAC)" if context.dimension == "country" else "MSCI World (SWDA)"
        basis = result.get("data")
        zh, en = f"{benchmark} 暂无可比权重。", f"No comparable {benchmark} weight is available."
        if basis:
            ref, stamp = basis["weight"], basis["as_of"]
            zh, en = (
                f"{benchmark} 截至 {stamp} 的权重为 {ref:.2%}，相差 {(weight - ref) * 100:+.2f} 个百分点。",
                f"{benchmark} had a {ref:.2%} weight on {stamp}, a difference of {(weight - ref) * 100:+.2f} pp.",
            )
        facts.append(observation("benchmark", zh, en, result, "exposure_benchmark"))
    if (coverage := data.get("lookthrough_coverage_fraction")) is not None and coverage < 0.99995:
        facts.append(
            observation(
                "coverage",
                f"本次穿透覆盖 {coverage:.1%}。",
                f"Look-through coverage was {coverage:.1%}.",
            )
        )
    return facts


EXPOSURE = PageRole(
    "exposure",
    "holdings",
    frozenset({"lookthrough_exposure", "dated_exposure", "exposure_benchmark"}),
    ExposureContext,
    "Select one verified observation per section. Preserve the dates, coverage and distinct portfolio and benchmark bases.",
    exposure_facts,
    data_version=exposure_version,
)
