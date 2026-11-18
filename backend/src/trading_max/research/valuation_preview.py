"""Deterministic valuation previews over frozen, evidence-linked inputs."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from pydantic import ConfigDict, Field, FiniteFloat

from trading_max.domain import DomainModel
from trading_max.research.facts import EvidenceRef, fingerprint
from trading_max.research.valuation_basis import Family, PeriodChoice

LEGACY_VERSION = "equity-proxy-projection-v1"
VALUATION_FORMULA_VERSION = "statement-equity-v2"
FormulaVersion = Literal["equity-proxy-projection-v1", "statement-equity-v2"]
REVERSE_GROWTH_BOUNDS = (-0.3, 0.8)


class ScenarioInputs(DomainModel):
    model_config = ConfigDict(allow_inf_nan=False)
    revenue_cagr: float | None = Field(default=None, ge=-0.8, le=2)
    target_fcf_margin: float | None = Field(default=None, ge=-1, le=1)
    discount_rate: float = Field(ge=0.01, le=0.6)
    exit_fcf_multiple: float | None = Field(default=None, ge=0, le=100)
    share_cagr: float | None = Field(default=None, ge=-0.3, le=1)
    ramp_years: int = Field(default=3, ge=1, le=10)
    initial_roe: float | None = Field(default=None, ge=-0.8, le=2)
    payout: float | None = Field(default=None, ge=0, le=1)
    terminal_pb: float | None = Field(default=None, ge=0, le=15)


class AssumptionReference(DomainModel):
    metric: Literal["revenueGrowth"] = "revenueGrowth"
    scenario: Literal["bear", "base", "bull"]
    period: str
    as_of: str
    value: float
    source: Literal["yahoo-finance-consensus", "historical-revenue-cagr"] = (
        "yahoo-finance-consensus"
    )
    reference_value: float | None = None
    adjustment: float = 0
    evidence: list[EvidenceRef] = Field(default_factory=list)


class ValuationPreviewRequest(DomainModel):
    family: Family | None = None
    formula_version: FormulaVersion = VALUATION_FORMULA_VERSION
    horizon: Literal[5, 10] = 5
    scenarios: dict[Literal["bear", "base", "bull"], ScenarioInputs]
    data_version: str | None = None
    references: list[AssumptionReference] = Field(default_factory=list, max_length=3)


class FrozenValuationBasis(DomainModel):
    model_config = ConfigDict(allow_inf_nan=False)
    ticker: str
    quote_id: str
    data_version: str
    currency: str
    spot: float = Field(gt=0)
    # Held securities are valued against the broker price the holdings page shows.
    spot_source: Literal["quote", "broker"] = "quote"
    spot_as_of: str | None = None
    family: Family = "cash-flow"
    period_id: str | None = None
    period_choice: PeriodChoice | None = None
    reporting_currency: str | None = None
    fx_rate: float | None = Field(default=None, gt=0)
    ordinary_per_receipt: float | None = Field(default=None, gt=0)
    opening_cash: float | None = Field(default=None, ge=0)
    book_per_share: float | None = Field(default=None, gt=0)
    common_earnings: FiniteFloat | None = None
    revenue: float | None = Field(ge=0)
    shares: float = Field(gt=0)
    start_margin: FiniteFloat
    cash_flow_type: Literal[
        "operating-cash-flow-less-capex-equity-proxy", "net-income-proxy", "residual-income"
    ] = "operating-cash-flow-less-capex-equity-proxy"
    discount_rate_type: Literal["cost-of-equity"] = "cost-of-equity"
    evidence: list[EvidenceRef] = Field(default_factory=list)


class ProjectionYear(DomainModel):
    model_config = ConfigDict(allow_inf_nan=False)
    year: int
    growth: float | None
    revenue: float | None
    fcf_margin: float | None
    free_cashflow: float | None
    financing: float | None = None
    roe: float | None = None
    closing_book: float | None = None
    earnings_per_share: float | None = None
    shares: float
    cashflow_per_share: float
    discount_factor: float
    present_value: float


class ScenarioProjection(DomainModel):
    model_config = ConfigDict(allow_inf_nan=False)
    inputs: ScenarioInputs
    years: list[ProjectionYear]
    operating_value: float
    terminal_value: float
    terminal_present_value: float
    terminal_premium_present_value: float | None = None
    terminal_contribution: float | None
    equity_floor_adjustment: float = 0
    value: float
    upside: float


class SensitivityCell(DomainModel):
    growth: float
    discount_rate: float
    value: float
    upside: float


class ValuationPreview(DomainModel):
    family_selection: Literal["automatic", "override"] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    model_config = ConfigDict(allow_inf_nan=False)
    id: str
    formula_version: FormulaVersion = LEGACY_VERSION
    basis: FrozenValuationBasis
    horizon: Literal[5, 10]
    scenarios: dict[str, ScenarioProjection]
    sensitivity: list[SensitivityCell]
    reverse_metric: Literal[
        "revenue-growth", "target-margin", "initial-roe", "year-five-revenue"
    ] = "revenue-growth"
    reverse_value: float | None = None
    reverse_bound: Literal["below", "above"] | None = None
    reverse_limits: tuple[float, float] | None = None
    reverse_reason: str | None = None
    reverse_inputs: ScenarioInputs | None = None
    implied_growth: float | None
    implied_growth_bound: Literal["below", "above"] | None = None
    implied_growth_reason: str | None = None
    references: list[AssumptionReference] = Field(default_factory=list)
    default_source: (
        Literal["saved-model", "configured-scenarios", "sector-template", "user-input"] | None
    ) = None


def project(
    basis: FrozenValuationBasis,
    inputs: ScenarioInputs,
    horizon: int,
    version: FormulaVersion = VALUATION_FORMULA_VERSION,
) -> ScenarioProjection:
    """Value one quoted share. All currency amounts use the quote's major unit."""
    years = []
    opening_book = 0.0
    discounted_dividends = 0.0
    revenue, shares, cash = basis.revenue, basis.shares, basis.opening_cash
    residual = basis.family == "residual-income"
    if version == LEGACY_VERSION and basis.family != "cash-flow":
        raise ValueError("legacy-cash-flow-family-required")
    if not residual and None in (
        revenue,
        inputs.revenue_cagr,
        inputs.target_fcf_margin,
        inputs.exit_fcf_multiple,
        inputs.share_cagr,
    ):
        raise ValueError("complete-cash-flow-assumptions-required")
    if residual:
        if basis.book_per_share is None or None in (
            inputs.initial_roe,
            inputs.payout,
            inputs.terminal_pb,
        ):
            raise ValueError("book-roe-payout-and-terminal-pb-required")
        book = opening_book = basis.book_per_share
    for year in range(1, horizon + 1):
        discount = 1 / (1 + inputs.discount_rate) ** year
        if residual:
            roe = inputs.initial_roe + (inputs.discount_rate - inputs.initial_roe) * (year - 1) / (
                horizon - 1
            )
            earnings = book * roe
            residual_income = earnings - inputs.discount_rate * book
            # Only positive earnings pay dividends. Losses reduce book in full.
            dividend = max(earnings, 0) * inputs.payout
            discounted_dividends += dividend * discount
            book += earnings - dividend
            years.append(
                ProjectionYear(
                    year=year,
                    growth=None,
                    revenue=None,
                    fcf_margin=None,
                    free_cashflow=None,
                    roe=roe,
                    closing_book=book,
                    earnings_per_share=earnings,
                    shares=shares,
                    cashflow_per_share=residual_income,
                    discount_factor=discount,
                    present_value=residual_income * discount,
                )
            )
            continue
        growth = inputs.revenue_cagr
        if year > 5:
            growth += (0.03 - growth) * (year - 5) / (horizon - 5)
        revenue *= 1 + growth
        ramp = 3 if version == LEGACY_VERSION else inputs.ramp_years
        margin = basis.start_margin + (inputs.target_fcf_margin - basis.start_margin) * min(
            year / ramp, 1
        )
        flow = revenue * margin
        shares = (
            basis.shares * (1 + inputs.share_cagr) ** year
            if version == LEGACY_VERSION
            else shares * (1 + inputs.share_cagr)
        )
        financing = 0.0
        if flow < 0 and version != LEGACY_VERSION and basis.family == "cash-flow":
            if cash is None:
                raise ValueError("opening-cash-required-for-burn")
            burn = -flow
            financing = max(0, burn - cash)
            cash = max(0, cash - burn)
            shares += financing / basis.spot
        # New subscribers fund the uncovered deficit. Their proceeds offset
        # that portion of the loss; their shares dilute subsequent distributions.
        per_share = (flow + financing) / shares
        years.append(
            ProjectionYear(
                year=year,
                growth=growth,
                revenue=revenue,
                fcf_margin=margin,
                free_cashflow=flow,
                shares=shares,
                financing=financing or None,
                cashflow_per_share=per_share,
                discount_factor=discount,
                present_value=per_share * discount,
            )
        )
    operating = opening_book + sum(y.present_value for y in years)
    terminal = (
        inputs.terminal_pb * book
        if residual
        else max(years[-1].cashflow_per_share, 0) * inputs.exit_fcf_multiple
    )
    terminal_pv = terminal * years[-1].discount_factor
    premium_pv = (inputs.terminal_pb - 1) * book * years[-1].discount_factor if residual else None
    # The clean-surplus identity avoids cancellation between book and the terminal premium.
    raw_value = (discounted_dividends if residual else operating) + terminal_pv
    value = max(raw_value, 0)
    return ScenarioProjection(
        inputs=inputs,
        years=years,
        operating_value=operating,
        terminal_value=terminal,
        terminal_present_value=terminal_pv,
        terminal_premium_present_value=premium_pv,
        terminal_contribution=terminal_pv / value if value else None,
        equity_floor_adjustment=max(-raw_value, 0),
        value=value,
        upside=value / basis.spot - 1,
    )


def _financed_margin(basis: FrozenValuationBasis, base: ScenarioInputs, horizon: int):
    """Isolate a unique price crossing over all piecewise financing regimes."""
    from functools import lru_cache
    from itertools import pairwise

    @lru_cache(maxsize=128)
    def projection(margin):
        return project(basis, base.model_copy(update={"target_fcf_margin": margin}), horizon)

    low, high = -1.0, 1.0
    # Revenue is fixed in this reverse reading. Each year's flow is affine
    # in target margin. Split first where flow changes sign.
    knots = {low, high}
    for a, b in zip(projection(low).years, projection(high).years, strict=True):
        if a.free_cashflow < 0 < b.free_cashflow:
            knots.add(low - a.free_cashflow * (high - low) / (b.free_cashflow - a.free_cashflow))
    # Between these knots cumulative burn is also affine. Each crossing of
    # opening cash changes which year's loss is covered by share issuance.
    for left, right in pairwise(sorted(knots)):
        cash_a = cash_b = basis.opening_cash
        for a, b in zip(projection(left).years, projection(right).years, strict=True):
            cash_a += min(0, a.free_cashflow)
            cash_b += min(0, b.free_cashflow)
            if cash_a < 0 < cash_b:
                knots.add(left - cash_a * (right - left) / (cash_b - cash_a))

    roots = set()
    for left, right in pairwise(sorted(knots)):
        a, b = projection(left), projection(right)
        lower_pv = upper_pv = min_slope = max_slope = 0.0
        for y, z in zip(a.years, b.years, strict=True):
            pv_a, pv_b = y.present_value, z.present_value
            if y.year == horizon:
                pv_a += a.terminal_present_value
                pv_b += b.terminal_present_value
            # Within a regime each PV term is affine divided by positive
            # affine shares. Its extremes and derivative extremes are at the
            # ends. Summing them bounds both value and slope throughout.
            lower_pv += min(pv_a, pv_b)
            upper_pv += max(pv_a, pv_b)
            delta = pv_b - pv_a
            slopes = delta * z.shares / y.shares, delta * y.shares / z.shares
            min_slope += min(slopes)
            max_slope += max(slopes)
        if basis.spot < lower_pv or basis.spot > upper_pv:
            continue
        if min_slope <= 0 <= max_slope:
            return None, None, "target-margin-not-unique"
        if a.value == basis.spot:
            roots.add(left)
        elif b.value == basis.spot:
            roots.add(right)
        elif min(a.value, b.value) < basis.spot < max(a.value, b.value):
            for _ in range(60):
                middle = (left + right) / 2
                if (projection(middle).value < basis.spot) == (a.value < b.value):
                    left = middle
                else:
                    right = middle
            roots.add((left + right) / 2)
        if len(roots) > 1:
            return None, None, "target-margin-not-unique"
    if roots:
        return roots.pop(), None, None
    return None, "above" if projection(high).value < basis.spot else "below", None


def _solve(value: Callable[[float], float], low: float, high: float, spot: float):
    lower, upper = value(low), value(high)
    if upper <= lower:
        return None, None, "non-monotonic-or-flat-cashflows"
    if spot < lower or spot > upper:
        return None, "below" if spot < lower else "above", None
    for _ in range(64):
        middle = (low + high) / 2
        if value(middle) < spot:
            low = middle
        else:
            high = middle
    return (low + high) / 2, None, None


def preview(basis: FrozenValuationBasis, request: ValuationPreviewRequest) -> ValuationPreview:
    if request.data_version and request.data_version != basis.data_version:
        raise ValueError("research-data-version-changed")
    if request.family and request.family != basis.family:
        raise ValueError("family-basis-mismatch")
    if set(request.scenarios) != {"bear", "base", "bull"}:
        raise ValueError("three-complete-scenarios-required")
    base = request.scenarios["base"]
    version = request.formula_version
    common = {
        "id": fingerprint([version, basis.model_dump(), request.model_dump()]),
        "formula_version": version,
        "basis": basis,
        "horizon": request.horizon,
        "references": request.references,
        "implied_growth": None,
    }
    if basis.family != "residual-income" and basis.revenue == 0:
        # Pure reverse reading: no interim payouts, positive year-five margin
        # and terminal multiple. All the market value is backed by terminal earnings.
        if None in (base.target_fcf_margin, base.exit_fcf_multiple, base.share_cagr):
            raise ValueError("target-margin-multiple-and-share-change-required")
        multiple_margin = base.target_fcf_margin * base.exit_fcf_multiple
        required = (
            basis.spot
            * basis.shares
            * ((1 + base.share_cagr) * (1 + base.discount_rate)) ** 5
            / multiple_margin
            if multiple_margin > 0
            else None
        )
        return ValuationPreview(
            **common,
            scenarios={},
            sensitivity=[],
            reverse_metric="year-five-revenue",
            reverse_inputs=base,
            reverse_value=required,
            reverse_reason=None
            if required is not None
            else "positive-target-and-multiple-required",
        )

    def calculate(params):
        return project(basis, params, request.horizon, version)

    scenarios = {key: calculate(params) for key, params in request.scenarios.items()}
    residual = basis.family == "residual-income"
    axis = "initial_roe" if residual else "revenue_cagr"
    centre = getattr(base, axis)
    cells = []
    for discount_delta in (-0.02, -0.01, 0, 0.01, 0.02):
        for axis_delta in (-0.1, -0.05, 0, 0.05, 0.1):
            x = max(-0.8, min(2, centre + axis_delta))
            discount = min(0.6, max(0.01, base.discount_rate + discount_delta))
            projection = calculate(base.model_copy(update={axis: x, "discount_rate": discount}))
            cells.append(
                SensitivityCell(
                    growth=x,
                    discount_rate=discount,
                    value=projection.value,
                    upside=projection.upside,
                )
            )
    reverse = "initial-roe" if residual else "revenue-growth"
    field = axis
    limits = (-0.8, 2.0) if residual else REVERSE_GROWTH_BOUNDS
    if not residual and min(basis.start_margin, base.target_fcf_margin) < 0:
        reverse, field, limits = "target-margin", "target_fcf_margin", (-1.0, 1.0)

    def value(x):
        return calculate(base.model_copy(update={field: x})).value

    if version == LEGACY_VERSION and reverse == "target-margin":
        implied, bound, reason = None, None, "non-monotonic-or-flat-cashflows"
        reverse, limits = "revenue-growth", REVERSE_GROWTH_BOUNDS
    else:
        try:
            if reverse == "target-margin" and basis.family == "cash-flow":
                if basis.opening_cash is None:
                    raise ValueError("opening-cash-required-for-burn")
                implied, bound, reason = _financed_margin(basis, base, request.horizon)
            else:
                implied, bound, reason = _solve(value, *limits, basis.spot)
        except ValueError as exc:
            if str(exc) != "opening-cash-required-for-burn":
                raise
            implied, bound, reason = None, None, str(exc)
    if reverse == "revenue-growth":
        common.update(
            implied_growth=implied, implied_growth_bound=bound, implied_growth_reason=reason
        )
    return ValuationPreview(
        **common,
        scenarios=scenarios,
        sensitivity=cells,
        reverse_metric=reverse,
        reverse_value=implied,
        reverse_bound=bound,
        reverse_limits=limits,
        reverse_reason=reason,
    )
