"""Explain how a saved valuation moves to a new proposal.

The walk replays the saved assumptions on four bases in a fixed order, so its
parts add up exactly to the proposal:

1. the saved model's own frozen basis;
2. the newest statements at the saved price and exchange rate (new financial base);
3. the current price and exchange rate (price and FX);
4. the proposed assumptions on the current basis (changed assumptions).

A restatement of the saved period is measured within the first part, before
the newest period replaces it, and is reported on its own. Nothing here reads
providers, chooses assumptions or writes state.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Literal, NamedTuple, get_args

from pydantic import Field

from trading_max.domain import DomainModel

from .estimate_history import EstimateObservation
from .facts import METRICS, FinancialFacts, MetricObservation
from .valuation_basis import Family, PeriodChoice
from .valuation_preview import (
    FormulaVersion,
    FrozenValuationBasis,
    InputField,
    LockedInput,
    Scenario,
    ScenarioInputs,
    ValuationPreview,
    project,
)

SCENARIOS: tuple[Scenario, ...] = ("bear", "base", "bull")
# Four quarters and the fiscal year ending on the same day disagree beyond this share.
CONFLICT_TOLERANCE = 0.005
_ORDINARY_FIELDS = frozenset(METRICS["ordinaryShares"])

FigureMetric = Literal[
    "revenue",
    "startMargin",
    "freeCashflow",
    "earnings",
    "cash",
    "commonEquity",
    "listingShares",
]
RestatementCheck = Literal["unchanged", "restated", "unavailable"]
# Why some or all of the saved period could not be compared with the current statements.
RestatementGap = Literal["period-missing", "metrics-incomplete", "currency-changed"]


class ValuationMaintenanceRequest(DomainModel):
    model_id: str = Field(min_length=1, max_length=64)
    horizon: Literal[5, 10]
    scenarios: dict[Scenario, ScenarioInputs] = Field(min_length=3, max_length=3)
    data_version: str | None = None
    locked_inputs: list[LockedInput] = Field(default_factory=list, max_length=27)


class BasisPoint(DomainModel):
    period_id: str | None
    period_choice: PeriodChoice | None
    spot: float
    spot_source: Literal["quote", "broker"]
    spot_as_of: str | None
    fx_rate: float | None
    reporting_currency: str | None


class ScenarioWalk(DomainModel):
    """Per-share values in the quote's major unit, and the change each part adds."""

    saved: float
    restated: float | None = None
    statements: float
    price_fx: float
    proposal: float
    restatement_effect: float | None = None
    statements_effect: float
    price_fx_effect: float
    assumptions_effect: float


class FigureChange(DomainModel):
    metric: FigureMetric
    saved: float | None
    current: float | None
    unit: Literal["currency", "ratio", "shares"]
    currency: str | None = None


class Restatement(DomainModel):
    """A figure of the saved period that the current statements report differently."""

    period_id: str
    metric: FigureMetric
    saved: float
    current: float
    unit: Literal["currency", "shares"]
    currency: str | None = None


class SourceConflict(DomainModel):
    """Two statements of one quantity that disagree; neither is blended into the other."""

    kind: Literal["quarters-vs-fiscal-year", "conflicting-source-rows"]
    period_id: str
    metric: str
    quarters: float | None = None
    fiscal_year: float | None = None
    unit: Literal["currency", "shares"]
    currency: str | None = None
    # Conflicting rows in the fiscal year the four quarters are checked against:
    # that check cannot run for this figure.
    blocks_comparison: bool = False


class EstimateChange(DomainModel):
    metric: Literal["consensusEps", "consensusRevenueGrowth"]
    period_end: date
    currency: str | None = None
    saved: float
    current: float
    saved_as_of: datetime | date | None = None
    current_as_of: datetime | date | None = None


class AssumptionChange(DomainModel):
    scenario: Scenario
    field: InputField
    saved: float | None
    proposed: float | None
    locked: bool = False


class ValuationMaintenance(DomainModel):
    model_id: str
    saved_at: datetime
    family: Family
    formula_version: FormulaVersion
    horizon: Literal[5, 10]
    currency: str
    saved: BasisPoint
    current: BasisPoint
    # False when the reporting currency changed: the rate then moves with the statements.
    fx_separated: bool
    scenarios: dict[Scenario, ScenarioWalk]
    figures: list[FigureChange]
    restatement_check: RestatementCheck
    restatement_gap: RestatementGap | None = None
    # Figures of the saved period that the current statements no longer report.
    unchecked_figures: list[FigureMetric] = Field(default_factory=list)
    restatements: list[Restatement]
    conflicts: list[SourceConflict]
    estimates: list[EstimateChange]
    assumptions: list[AssumptionChange]
    locked_inputs: list[LockedInput]
    new_statements: bool
    new_estimates: bool


def _same(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)


def basis_point(basis: FrozenValuationBasis) -> BasisPoint:
    return BasisPoint(
        period_id=basis.period_id,
        period_choice=basis.period_choice,
        spot=basis.spot,
        spot_source=basis.spot_source,
        spot_as_of=basis.spot_as_of,
        fx_rate=basis.fx_rate,
        reporting_currency=basis.reporting_currency,
    )


def basis_figures(basis: FrozenValuationBasis) -> dict[str, float]:
    """Statement inputs of a frozen basis, back in its reporting currency."""
    fx = basis.fx_rate
    if not fx:
        return {}
    figures = {"listingShares": basis.shares}
    if basis.revenue is not None:
        figures["revenue"] = basis.revenue / fx
    if basis.family == "residual-income":
        if basis.common_earnings is not None:
            figures["earnings"] = basis.common_earnings / fx
        if basis.book_per_share is not None:
            figures["commonEquity"] = basis.book_per_share * basis.shares / fx
    elif basis.revenue:
        flow = basis.start_margin * basis.revenue / fx
        figures["freeCashflow" if basis.family == "cash-flow" else "earnings"] = flow
    if basis.family == "cash-flow" and basis.opening_cash is not None:
        figures["cash"] = basis.opening_cash / fx
    return figures


def period_figures(
    facts: FinancialFacts, family: Family, period_id: str, ordinary_per_receipt: float | None
) -> dict[str, float]:
    """The same inputs for one statement period, as the current statements report them."""
    values = {
        o.metric: o.value
        for o in facts.observations
        if o.period_id == period_id and o.state == "available" and o.value is not None
    }
    figures: dict[str, float] = {}
    if values.get("revenue") is not None and values["revenue"] >= 0:
        figures["revenue"] = values["revenue"]
    if family == "cash-flow":
        if "freeCashflow" in values:
            figures["freeCashflow"] = values["freeCashflow"]
        if values.get("cash") is not None and values["cash"] >= 0:
            figures["cash"] = values["cash"]
    else:
        # The same precedence as the desk: common earnings, then net income.
        income = values.get("commonIncome", values.get("netIncome"))
        if income is not None:
            figures["earnings"] = income
        if family == "residual-income" and (values.get("commonEquity") or 0) > 0:
            figures["commonEquity"] = values["commonEquity"]
    if (values.get("ordinaryShares") or 0) > 0:
        figures["listingShares"] = values["ordinaryShares"] / (ordinary_per_receipt or 1)
    return figures


def _statement_shares(basis: FrozenValuationBasis) -> bool:
    """Whether the share count came from the period's balance sheet, not the quote."""
    return any(ref.field.partition(".")[2] in _ORDINARY_FIELDS for ref in basis.evidence)


class Restating(NamedTuple):
    """The saved period as the current statements report it.

    ``basis`` is the saved basis with the restated figures. It is None, and the
    combined effect withheld, unless every figure the saved basis used is restated
    or confirmed.
    """

    basis: FrozenValuationBasis | None
    changes: list[Restatement]
    check: RestatementCheck
    gap: RestatementGap | None = None
    unchecked: tuple[FigureMetric, ...] = ()


def restate(saved: FrozenValuationBasis, facts: FinancialFacts | None) -> Restating:
    """Compare the saved period with the current statements of that same period.

    Each figure that the current statements still report is compared on its own.
    """
    if facts is None or not saved.period_id or not saved.fx_rate or not saved.reporting_currency:
        return Restating(None, [], "unavailable", "period-missing")
    if facts.currency != saved.reporting_currency:
        return Restating(None, [], "unavailable", "currency-changed")
    if all(p.id != saved.period_id for p in facts.periods):
        return Restating(None, [], "unavailable", "period-missing")
    before = basis_figures(saved)
    if not _statement_shares(saved):
        before.pop("listingShares", None)
    after = period_figures(facts, saved.family, saved.period_id, saved.ordinary_per_receipt)
    unchecked = tuple(m for m in get_args(FigureMetric) if m in before and m not in after)
    gap: RestatementGap | None = "metrics-incomplete" if unchecked else None
    if len(unchecked) == len(before):
        return Restating(None, [], "unavailable", "metrics-incomplete", unchecked)
    changes = [
        Restatement(
            period_id=saved.period_id,
            metric=metric,
            saved=value,
            current=after[metric],
            unit="shares" if metric == "listingShares" else "currency",
            currency=None if metric == "listingShares" else saved.reporting_currency,
        )
        for metric, value in before.items()
        if metric in after and not _same(value, after[metric])
    ]
    if not changes:
        return Restating(None, [], "unchanged", gap, unchecked)
    if unchecked:
        return Restating(None, changes, "restated", gap, unchecked)
    fx = saved.fx_rate
    # Only a share count from the period's balance sheet can be restated. A quoted
    # count stays; a change of its source belongs to the new financial base.
    shares = after["listingShares"] if "listingShares" in before else saved.shares
    update: dict[str, float] = {"shares": shares}
    if "revenue" in before:
        update["revenue"] = after["revenue"] * fx
    for flow in ("freeCashflow", "earnings"):
        if flow in before and saved.family != "residual-income":
            update["start_margin"] = after[flow] / after["revenue"] if after.get("revenue") else 0
    if "cash" in before:
        update["opening_cash"] = after["cash"] * fx
    if saved.family == "residual-income":
        if "earnings" in before:
            update["common_earnings"] = after["earnings"] * fx
        if "commonEquity" in before:
            update["book_per_share"] = after["commonEquity"] * fx / shares
    return Restating(saved.model_copy(update=update), changes, "restated")


def _with_market(
    basis: FrozenValuationBasis, market: FrozenValuationBasis, fx: float | None
) -> FrozenValuationBasis:
    """The same statements at another spot and, when given, another exchange rate."""
    update: dict[str, object] = {
        "spot": market.spot,
        "spot_source": market.spot_source,
        "spot_as_of": market.spot_as_of,
    }
    if fx is not None and basis.fx_rate and fx != basis.fx_rate:
        scale = fx / basis.fx_rate
        update["fx_rate"] = fx
        for field in ("revenue", "common_earnings", "opening_cash", "book_per_share"):
            value = getattr(basis, field)
            if value is not None:
                update[field] = value * scale
    return basis.model_copy(update=update)


def fx_separable(saved: FrozenValuationBasis, current: FrozenValuationBasis) -> bool:
    return bool(
        saved.fx_rate
        and current.fx_rate
        and saved.reporting_currency
        and saved.reporting_currency == current.reporting_currency
    )


def scenario_walk(
    saved: ValuationPreview,
    current: FrozenValuationBasis,
    proposed: Mapping[str, ScenarioInputs],
    horizon: int,
    restated: FrozenValuationBasis | None = None,
) -> dict[Scenario, ScenarioWalk]:
    if saved.basis.currency != current.currency:
        raise ValueError("valuation-currency-changed")
    if saved.basis.family != current.family:
        raise ValueError("family-basis-mismatch")
    version = saved.formula_version
    rate = saved.basis.fx_rate if fx_separable(saved.basis, current) else None
    statements = _with_market(current, saved.basis, rate)
    walk = {}
    for key in SCENARIOS:
        inputs = saved.scenarios[key].inputs

        def value(basis: FrozenValuationBasis, params: ScenarioInputs = inputs) -> float:
            return project(basis, params, horizon, version).value

        start = value(saved.basis)
        corrected = value(restated) if restated is not None else None
        rolled = value(statements)
        repriced = value(current)
        proposal = value(current, proposed[key])
        walk[key] = ScenarioWalk(
            saved=start,
            restated=corrected,
            statements=rolled,
            price_fx=repriced,
            proposal=proposal,
            restatement_effect=corrected - start if corrected is not None else None,
            statements_effect=rolled - start,
            price_fx_effect=repriced - rolled,
            assumptions_effect=proposal - repriced,
        )
    return walk


def figure_changes(
    saved: FrozenValuationBasis, current: FrozenValuationBasis
) -> list[FigureChange]:
    """The statement inputs that moved, each in the reporting currency of its statements."""
    same_currency = fx_separable(saved, current)
    before, after = basis_figures(saved), basis_figures(current)
    if saved.family != "residual-income":
        before["startMargin"], after["startMargin"] = saved.start_margin, current.start_margin
    changes = []
    for metric in get_args(FigureMetric):
        a, b = before.get(metric), after.get(metric)
        if (a is None and b is None) or (a is not None and b is not None and _same(a, b)):
            continue
        unit = (
            "ratio"
            if metric == "startMargin"
            else "shares"
            if metric == "listingShares"
            else "currency"
        )
        if unit == "currency" and not same_currency:
            continue
        changes.append(
            FigureChange(
                metric=metric,
                saved=a,
                current=b,
                unit=unit,
                currency=current.reporting_currency if unit == "currency" else None,
            )
        )
    return changes


_CONFLICT_METRICS: dict[str, tuple[str, ...]] = {
    "cash-flow": ("revenue", "freeCashflow", "cash", "ordinaryShares"),
    "net-income": ("revenue", "commonIncome", "netIncome", "ordinaryShares"),
    "residual-income": ("commonIncome", "commonEquity", "ordinaryShares"),
}
_SOURCE_METRICS: dict[str, tuple[str, ...]] = {
    "cash-flow": ("revenue", "operatingCashflow", "capex", "cash", "ordinaryShares"),
    "net-income": ("revenue", "commonIncome", "netIncome", "ordinaryShares"),
    "residual-income": ("commonIncome", "commonEquity", "ordinaryShares"),
}


def source_conflicts(
    facts: FinancialFacts | None, family: Family, period_id: str | None
) -> list[SourceConflict]:
    """Disagreements behind the current statement basis, the fiscal year it is checked
    against and any newer period it skipped."""
    periods = {p.id: p for p in facts.periods} if facts else {}
    period = periods.get(period_id or "")
    if facts is None or period is None:
        return []
    observed = {(o.period_id, o.metric): o for o in facts.observations}

    def available(pid: str, metric: str) -> MetricObservation | None:
        row = observed.get((pid, metric))
        if row is None or row.state != "available" or row.value is None:
            return None
        return row

    conflicts = []
    annual = (
        next(
            (
                p
                for p in facts.periods
                if p.kind == "annual" and p.provider_end == period.provider_end
            ),
            None,
        )
        if period.kind == "ttm"
        else None
    )
    # The precedence of the basis: available common earnings, then net income.
    income = "commonIncome" if available(period.id, "commonIncome") else "netIncome"
    for metric in _CONFLICT_METRICS[family] if annual else ():
        if metric in {"commonIncome", "netIncome"} and metric != income:
            continue
        quarters, year = available(period.id, metric), available(annual.id, metric)
        if (
            quarters is not None
            and year is not None
            and not math.isclose(quarters.value, year.value, rel_tol=CONFLICT_TOLERANCE)
        ):
            shares = metric == "ordinaryShares"
            conflicts.append(
                SourceConflict(
                    kind="quarters-vs-fiscal-year",
                    period_id=period.id,
                    metric=metric,
                    quarters=quarters.value,
                    fiscal_year=year.value,
                    unit="shares" if shares else "currency",
                    currency=None if shares else facts.currency,
                )
            )
    covered = set(period.components) | ({period.id} if period.kind == "annual" else set())
    newer = {
        p.id
        for p in facts.periods
        if p.kind in {"quarterly", "annual"} and p.provider_end > period.provider_end
    }
    compared = {annual.id} if annual else set()
    scanned = sorted(covered | newer | compared, key=lambda pid: (periods[pid].provider_end, pid))
    for candidate in scanned:
        for metric in _SOURCE_METRICS[family]:
            row = observed.get((candidate, metric))
            if row is not None and row.reason == "conflicting-source-rows":
                shares = metric == "ordinaryShares"
                conflicts.append(
                    SourceConflict(
                        kind="conflicting-source-rows",
                        period_id=candidate,
                        metric=metric,
                        unit="shares" if shares else "currency",
                        currency=None if shares else facts.currency,
                        blocks_comparison=candidate in compared
                        and (metric not in {"commonIncome", "netIncome"} or metric == income),
                    )
                )
    return conflicts


def eps_changes(
    saved: EstimateObservation | None, current: EstimateObservation | None
) -> list[EstimateChange]:
    """Fiscal-year EPS consensus at the save and now, for the same year end and currency."""
    if saved is None or current is None or saved.observed_at >= current.observed_at:
        return []

    def annual(observation: EstimateObservation):
        return {
            (e.period_end, e.currency): e.mean_eps
            for e in observation.consensus
            if e.period in {"0y", "+1y"}
            and e.period_end is not None
            and isinstance(e.currency, str)
            and len(e.currency) == 3
            and e.currency.isupper()
            and e.mean_eps is not None
            and math.isfinite(e.mean_eps)
        }

    before, after = annual(saved), annual(current)
    return [
        EstimateChange(
            metric="consensusEps",
            period_end=end,
            currency=currency,
            saved=before[(end, currency)],
            current=value,
            saved_as_of=saved.observed_at,
            current_as_of=current.observed_at,
        )
        for (end, currency), value in sorted(after.items(), key=lambda item: item[0][0])
        if (end, currency) in before and not _same(before[(end, currency)], value)
    ]


def revenue_growth_changes(
    saved: Iterable[tuple[date, float, datetime | date | None]],
    current: Iterable[tuple[date, float, datetime | date | None]],
) -> list[EstimateChange]:
    """Revenue-growth consensus for the same fiscal year end, recorded at the save and now."""
    before: dict[date, tuple[float, datetime | date | None]] = {}
    for end, value, as_of in saved:
        before.setdefault(end, (value, as_of))
    changes = []
    for end, value, as_of in sorted(current, key=lambda item: item[0]):
        if end in before and not _same(before[end][0], value):
            changes.append(
                EstimateChange(
                    metric="consensusRevenueGrowth",
                    period_end=end,
                    saved=before[end][0],
                    current=value,
                    saved_as_of=before[end][1],
                    current_as_of=as_of,
                )
            )
    return changes


def assumption_changes(
    saved: ValuationPreview,
    proposed: Mapping[str, ScenarioInputs],
    locked: Iterable[LockedInput] = (),
) -> list[AssumptionChange]:
    kept = {(item.scenario, item.field) for item in locked}
    changes = []
    for scenario in SCENARIOS:
        for field in get_args(InputField):
            before = getattr(saved.scenarios[scenario].inputs, field)
            after = getattr(proposed[scenario], field)
            if before != after:
                changes.append(
                    AssumptionChange(
                        scenario=scenario,
                        field=field,
                        saved=before,
                        proposed=after,
                        locked=(scenario, field) in kept,
                    )
                )
    return changes
