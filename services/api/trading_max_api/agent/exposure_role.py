"""Explain a selected, published look-through allocation and its dated comparators."""

from dataclasses import replace
from datetime import date, datetime, timedelta
from math import isclose
from typing import Literal

from pydantic import Field, model_validator
from trading_max.analytics.exposure_history import PREFIX, _countries
from trading_max.infrastructure.acwi_weights import AcwiWeights
from trading_max.infrastructure.sector_universe import GICS_SECTORS, SECTOR_ALIASES
from trading_max.infrastructure.world_sector_weights import WorldSectorWeights

from . import insights, tools
from .overview_roles import LONDON, line
from .roles import PageRole, RoleContext, RoleTools, bind_selection


class ExposureContext(RoleContext):
    dimension: Literal["country", "sector", "gics", "company"]
    category: str = Field(min_length=1, max_length=180)
    entityId: str | None = Field(default=None, min_length=1, max_length=512)
    citedBenchmark: Literal["SWDA", "SSAC"] | None = None
    citedBenchmarkAsOf: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    citedBenchmarkObservation: str | None = Field(default=None, pattern=r"^bw_[0-9a-f]{16}$")
    group: Literal["tail", "unresolved"] | None = None

    @model_validator(mode="after")
    def grouped_category(self):
        if any((self.citedBenchmark, self.citedBenchmarkAsOf, self.citedBenchmarkObservation)):
            if not (
                self.citedBenchmark
                and self.citedBenchmarkAsOf
                and self.citedBenchmarkObservation
                and self.citedBenchmark == {"country": "SSAC", "sector": "SWDA"}.get(self.dimension)
            ):
                raise ValueError("Invalid benchmark observation")
        if self.entityId and (self.dimension != "company" or self.group):
            raise ValueError("An entity identifies one company")
        if (self.group and self.category != self.group) or (
            self.group == "unresolved" and self.dimension != "company"
        ):
            raise ValueError("Invalid grouped allocation")
        return self


def _category(dimension, row):
    if dimension == "country":
        return _countries().get((row["name"] or "").lower(), row["name"])
    if dimension == "company":
        return row.get("isin") or row.get("ticker") or row["name"]
    return row["name"]


def _find(ctx, tool, args, context, *, allow_legacy=True):
    expected = (
        _countries().get(context.category.lower(), context.category)
        if context.dimension == "country"
        else context.category
    )
    rows = []
    while True:
        result = tool(ctx, args)
        data = result.get("data") or {}
        page = data.get("items", [])
        rows.extend(page)
        cursor = data.get("next_cursor")
        if cursor is None:
            break
        args = args.model_copy(update={"cursor": cursor})
    truncated = data.get("company_table_truncated", False) or len(rows) != data.get("total_items")
    if not context.group:
        matches = [row for row in rows if _category(context.dimension, row) == expected]
        if context.entityId:
            exact = [row for row in rows if row.get("entity_id") == context.entityId]
            if exact:
                return (
                    dict(exact[0], unique_category=len(matches) == 1) if len(exact) == 1 else None
                ), result
            # A fallback is valid only for a unique legacy row without its own identity.
            legacy = [row for row in matches if not row.get("entity_id")]
            if legacy and (not allow_legacy or len(matches) != 1):
                return None, result
            matches = legacy
        if matches:
            unique = len(matches) == 1 and not (context.dimension == "company" and truncated)
            return (matches[0] if unique else None), result
        if (
            tool is insights.dated_exposure
            and not truncated
            and _fully_classified(rows, data, result)
        ):
            return {"weight_fraction": 0.0, "value_gbp": 0.0}, result
        return None, result
    if truncated:
        return None, result
    members = rows[12:] if context.group == "tail" else rows
    if not members or any(row["weight_fraction"] is None for row in members):
        return None, result
    weight = sum(row["weight_fraction"] for row in members)
    if context.group == "unresolved":
        weight = 1 - weight
        if weight <= 0 or (
            tool is tools.lookthrough_exposure and not data.get("non_security_value_gbp")
        ):
            return None, result
    values = [row["value_gbp"] for row in members]
    value = sum(values) if all(v is not None for v in values) else None
    if context.group == "unresolved" and value is not None:
        total = data.get("invested_value_gbp")
        value = total - value if total is not None else None
    return {"weight_fraction": weight, "value_gbp": value}, result


def _fully_classified(rows, data, result):
    if not rows or result["quality"]["issues"]:
        return False
    if any(
        not row["name"]
        or row["name"].casefold() in {"unclassified", "unknown", "unresolved"}
        or row.get("classification_status", "classified") != "classified"
        or not _denominator_matches(row, data)
        for row in rows
    ):
        return False
    return isclose(sum(row["weight_fraction"] for row in rows), 1.0, abs_tol=0.00005)


def _denominator_matches(item, data):
    total = data.get("invested_value_gbp")
    value = item.get("value_gbp")
    weight = item.get("weight_fraction")
    return (
        total is not None
        and total > 0
        and value is not None
        and weight is not None
        and isclose(value / total, weight, abs_tol=max(0.01 / total, 0.00005))
    )


def _history(ctx, args, context, cutoff, current, current_data):
    # Retained days may be sparse, and each day can have a different classification.
    days = sorted(
        {
            ref.key[len(PREFIX) : -5]
            for ref in ctx.deps.manifest.artifacts
            if ref.key.startswith(PREFIX) and ref.key.endswith(".json")
        },
        reverse=True,
    )
    eligible = [day for day in days if day <= cutoff]
    for day in eligible or [cutoff]:
        prior, history = _find(
            ctx,
            insights.dated_exposure,
            insights.ExposureHistoryArgs(**args, on_or_before=day),
            context,
            allow_legacy=current.get("unique_category", True),
        )
        data = history.get("data") or {}
        if (
            prior
            and current_data.get("basis")
            and data.get("basis") == current_data["basis"]
            and data.get("currency") == current_data.get("currency") == "GBP"
            and data.get("observation_date") == day
            and data.get("broker_as_of")
            and datetime.fromisoformat(data["broker_as_of"]).astimezone(LONDON).date()
            == date.fromisoformat(day)
            and _denominator_matches(current, current_data)
            and _denominator_matches(prior, data)
        ):
            return prior, history
    return None, history


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
    raw = read.read(tools.LOOKTHROUGH) or {}
    stamp = tools._iso(raw.get("brokerAsOf"))
    observed = datetime.fromisoformat(stamp) if stamp else None
    names = [args.category]
    if args.group == "tail" and weights:
        rows, _, _ = tools._exposure_reading(raw, args.dimension)
        names = [row["name"] for row in rows[12:]]
    values = []
    if isinstance(weights, AcwiWeights):
        codes = _countries()
        by_code = {}
        for name, weight in weights.locations.items():
            code = codes.get(name.lower(), name)
            by_code[code] = by_code.get(code, 0) + weight
        values = [by_code.get(codes.get(name.lower(), name)) for name in names]
    elif isinstance(weights, WorldSectorWeights):
        for name in names:
            code = GICS_SECTORS.get(SECTOR_ALIASES.get(name, name))
            values.append(weights.sectors[code].weight if code in weights.sectors else None)
    value = sum(values) if values and all(value is not None for value in values) else None
    if (
        value is None
        or not observed
        or observed.utcoffset() is None
        or weights.as_of > observed.astimezone(LONDON).date()
    ):
        return read.missing("dated_benchmark_weight_unavailable")
    source_id = "SSAC" if isinstance(weights, AcwiWeights) else "SWDA"
    as_of = weights.as_of.isoformat()
    # An issuer can correct its figures without changing the holdings date.
    observation = tools._short_id("bw_", [source_id, as_of, args.dimension, names, value])
    read = replace(read, evidence_context=observation)
    if args.citedBenchmark and (
        args.citedBenchmark,
        args.citedBenchmarkAsOf,
        args.citedBenchmarkObservation,
    ) != (source_id, as_of, observation):
        return read.missing("cited_benchmark_unavailable")
    return read.result(
        data={
            "source": source_id,
            "observation": observation,
            "as_of": as_of,
            "weight": value,
            "dimension": args.dimension,
            "name": args.category,
        }
    )


def exposure_version(read: RoleTools, context: ExposureContext):
    benchmark = read.read(exposure_benchmark, {})
    return tools._short_id("exposure_", [read.deps.snapshot_id, benchmark.get("data")])


def selected_exposure(ctx: tools.Context, args: ExposureContext):
    """Only the selected allocation, its comparable dated observation and its coverage."""
    read = tools._Read(ctx.deps, "selected_exposure", args, "broker_total")
    query = {"scope": "broker_total", "dimension": args.dimension, "limit": 20}
    item, current = _find(ctx, tools.lookthrough_exposure, tools.ExposureArgs(**query), args)
    data = current.get("data") or {}
    if not item or item["weight_fraction"] is None or not data.get("broker_as_of"):
        return read.missing("selected_allocation_unavailable")
    day = datetime.fromisoformat(data["broker_as_of"]).astimezone(LONDON).date()
    cutoff = (day - timedelta(days=30)).isoformat()
    prior, history = _history(ctx, query, args, cutoff, item, data)
    previous = (
        {"date": history["data"]["observation_date"], "weight_fraction": prior["weight_fraction"]}
        if prior
        else None
    )
    return read.result(
        data={
            "name": args.category,
            "current": {"date": day.isoformat(), "weight_fraction": item["weight_fraction"]},
            "previous": previous,
            "cutoff": cutoff,
            "lookthrough_coverage_fraction": data.get("lookthrough_coverage_fraction"),
        },
        keys=[tools.LOOKTHROUGH, *([f"{PREFIX}{previous['date']}.json"] if previous else [])],
        issues=current["quality"]["issues"],
    )


def exposure_facts(read: RoleTools, context: ExposureContext):
    current = read.read(selected_exposure, {})
    data = current.get("data")
    if not data:
        return []
    day = date.fromisoformat(data["current"]["date"])
    arguments = {
        "dimension": context.dimension,
        "category": context.category,
        "snapshotId": read.deps.snapshot_id,
        **({"entityId": context.entityId} if context.entityId else {}),
        **({"group": context.group} if context.group else {}),
    }

    def observation(section, zh, en, result=current, tool="selected_exposure", **window):
        return line(
            section, zh, en, result, "exposure", tool, metric=section, **arguments, **window
        )

    weight = data["current"]["weight_fraction"]
    facts = [
        observation(
            "current",
            f"{day}，占已投资资产的 {weight:.2%}。",
            f"On {day}, this accounted for {weight:.2%} of invested assets.",
        )
    ]
    cutoff = data["cutoff"]
    if prior := data["previous"]:
        stamp = prior["date"]
        previous = prior["weight_fraction"]
        group_zh = " 两次均按当时的前十二项以外计算。" if context.group == "tail" else ""
        group_en = (
            " Both weights group the categories outside that date’s top twelve."
            if context.group == "tail"
            else ""
        )
        facts.append(
            observation(
                "history",
                f"{stamp} 占比 {previous:.2%}，此后变化 {(weight - previous) * 100:+.2f} 个百分点。{group_zh}",
                f"The weight was {previous:.2%} on {stamp}, a change of {(weight - previous) * 100:+.2f} pp since then.{group_en}",
                on_or_before=cutoff,
                start=stamp,
                end=day.isoformat(),
            )
        )
    else:
        facts.append(
            observation(
                "history",
                f"{cutoff} 或之前暂无这项分类的可比记录。",
                f"No comparable weight is recorded on or before {cutoff}.",
                on_or_before=cutoff,
                end=day.isoformat(),
            )
        )
    if context.dimension in {"country", "sector"}:
        result = read.read(exposure_benchmark, {})
        benchmark = "MSCI ACWI (SSAC)" if context.dimension == "country" else "MSCI World (SWDA)"
        basis = result.get("data")
        zh, en = f"{benchmark} 暂无可比权重。", f"No comparable {benchmark} weight is available."
        if context.citedBenchmark:
            zh, en = "引用的基准权重记录暂不可用。", "Cited benchmark weight unavailable."
        if basis:
            ref, stamp = basis["weight"], basis["as_of"]
            zh, en = (
                f"{benchmark} 截至 {stamp} 的权重为 {ref:.2%}，相差 {(weight - ref) * 100:+.2f} 个百分点。",
                f"{benchmark} had a {ref:.2%} weight on {stamp}, a difference of {(weight - ref) * 100:+.2f} pp.",
            )
        facts.append(
            observation(
                "benchmark",
                zh,
                en,
                result,
                "exposure_benchmark",
                end=day.isoformat(),
                **(
                    {
                        "start": basis["as_of"],
                        "benchmarkSource": basis["source"],
                        "benchmarkAsOf": basis["as_of"],
                        "benchmarkObservation": basis["observation"],
                    }
                    if basis
                    else {}
                ),
            )
        )
        if context.citedBenchmark:
            # A reopened benchmark citation always includes the supporting weight or its expiry.
            return [facts[0], facts[-1]]
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
    frozenset({"selected_exposure", "exposure_benchmark"}),
    ExposureContext,
    "Select one verified observation per section. Preserve the dates, coverage and distinct portfolio and benchmark bases.",
    exposure_facts,
    data_version=exposure_version,
    tool_bindings=bind_selection("selected_exposure", "exposure_benchmark"),
)
