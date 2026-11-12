"""Listing-bound public evidence and deterministic, in-memory valuation tools."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from enum import StrEnum
from hashlib import sha256
from threading import Lock
from typing import Annotated, Literal, Self

from pydantic import (
    AwareDatetime,
    ConfigDict,
    Field,
    FiniteFloat,
    StringConstraints,
    model_validator,
)

from trading_max.domain import DomainModel

from .facts import fingerprint
from .valuation_preview import (
    REVERSE_GROWTH_BOUNDS,
    VALUATION_FORMULA_VERSION,
    FrozenValuationBasis,
    ScenarioInputs,
    ScenarioProjection,
    SensitivityCell,
    ValuationPreviewRequest,
    preview,
)

MAX_EVIDENCE_BYTES = 64 * 1024
MAX_EVIDENCE_ROWS = 96
MAX_BATCH_CALLS = 16
MAX_BATCH_ROWS = 192

Token = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$")]
Ticker = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9^=._-]{1,32}$")]
Listing = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{1,12}:[A-Z0-9^=._-]{1,32}$")]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
Version = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{20}([a-f0-9]{44})?$")]
EvidenceId = Annotated[str, StringConstraints(pattern=r"^ve_[a-f0-9]{64}$")]
PreviewId = Annotated[str, StringConstraints(pattern=r"^vp_[a-f0-9]{64}$")]
LocatorField = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.+() -]{1,100}$")]
State = Literal["available", "missing", "unsupported"]
Scenario = Literal["bear", "base", "bull"]
Assumption = Literal[
    "revenue_cagr", "target_fcf_margin", "discount_rate", "exit_fcf_multiple", "share_cagr"
]
Reason = Literal[
    "no-evidence",
    "listing-identity-unavailable",
    "fields-not-permitted",
    "cashflow-model-not-applicable",
    "complete-ttm-currency-and-share-count-required",
    "currency-conversion-unavailable",
    "non-positive-starting-free-cash-flow",
    "starting-margin-outside-formula-bounds",
    "projection-outside-numeric-range",
]


class EvidenceLimitError(ValueError):
    """A frozen bundle or tool call batch exceeded its fixed budget."""


class EvidenceScopeError(ValueError):
    """An identifier or data source does not match the bound scope."""


class _FrozenModel(DomainModel):
    model_config = ConfigDict(frozen=True, allow_inf_nan=False, hide_input_in_errors=True)


class Metric(StrEnum):
    SPOT = "spot"
    SHARES = "sharesOutstanding"
    FX = "reportingToQuoteFx"
    REVENUE = "revenue"
    FREE_CASHFLOW = "freeCashflow"
    CASH_FROM_OPERATIONS = "operatingCashflow"
    CAPEX = "capex"
    FCF_MARGIN = "fcfMargin"
    STATEMENT_SHARES = "shareCount"
    REVENUE_GROWTH = "revenueGrowth"
    CONSENSUS_REVENUE = "consensusRevenue"
    CONSENSUS_REVENUE_GROWTH = "consensusRevenueGrowth"
    CONSENSUS_REVENUE_GROWTH_CHANGE = "consensusRevenueGrowthChange"
    CONSENSUS_EPS = "consensusEps"
    CONSENSUS_EPS_CHANGE = "consensusEpsChange"
    FORWARD_PE = "forwardPe"
    TRAILING_PE = "trailingPe"
    FORWARD_EPS = "forwardEps"
    TRAILING_EPS = "trailingEps"
    PRICE_TO_SALES = "priceToSales"
    PRICE_TO_BOOK = "priceToBook"
    EV_TO_EBITDA = "enterpriseToEbitda"
    TARGET_MEDIAN = "analystTargetMedian"
    COST_OF_EQUITY = "costOfEquity"


class EvidenceGroup(StrEnum):
    BASIS = "basis"
    OPERATING = "operating"
    EXPECTATIONS = "expectations"
    MARKET = "market"


BASIS_METRICS = frozenset(
    {Metric.SPOT, Metric.SHARES, Metric.FX, Metric.REVENUE, Metric.FREE_CASHFLOW}
)


class EvidenceBinding(_FrozenModel):
    """Set by trusted code before any tool arguments are parsed."""

    workspace_id: Token
    ticker: Ticker
    listing: Listing
    cutoff: AwareDatetime
    snapshot_run_id: Token
    permitted_fields: frozenset[Metric] = Field(max_length=len(Metric))


class EvidencePeriod(_FrozenModel):
    kind: Literal["spot", "ttm", "annual", "quarterly", "semiannual", "irregular", "forecast"]
    end: date | None = None
    start: date | None = None
    forecast_slot: Literal["0q", "+1q", "0y", "+1y"] | None = None
    component_ends: tuple[date, ...] = Field(default=(), max_length=4)


class EvidenceLocator(_FrozenModel):
    """A local logical key; there are no paths or provider URLs."""

    dataset: Literal["financials", "fundamentals", "valuation", "market", "analyst", "pe-archive"]
    field: LocatorField
    accession: Annotated[str, StringConstraints(pattern=r"^\d{10}-\d{2}-\d{6}$")] | None = None


class EvidenceValue(_FrozenModel):
    ticker: Ticker
    listing: Listing
    group: EvidenceGroup
    metric: Metric
    basis: Literal[
        "reported-statement",
        "statement-derived",
        "same-fiscal-period-yoy",
        "public-quote",
        "listing-shares",
        "identity-fx",
        "stored-valuation-fx",
        "provider-consensus",
        "same-fiscal-period-revision",
        "vendor-context",
        "analyst-target",
        "cost-of-equity-proxy",
    ]
    period: EvidencePeriod
    currency: Currency | None = None
    counter_currency: Currency | None = None
    native_quote_unit: Currency | Literal["GBp", "GBX", "GBx"] | None = None
    unit: Literal["currency", "perShare", "shares", "ratio", "multiple", "fx", "ratio-point"]
    source: Literal[
        "yahoo-finance",
        "yahoo-finance-financials",
        "yahoo-finance-consensus",
        "research-valuation",
        "currency-identity",
    ]
    locator: EvidenceLocator
    published_at: AwareDatetime | date | None = None
    observed_at: AwareDatetime | None = None
    version: Version | None = None
    state: State
    quality: Literal["observed", "derived", "retained", "recovered", "unavailable"]
    value: FiniteFloat | None = None

    @model_validator(mode="after")
    def check_availability(self) -> Self:
        if self.state == "available":
            if self.value is None or self.observed_at is None or self.version is None:
                raise ValueError(
                    "available evidence requires a value, observation time and version"
                )
        elif self.value is not None:
            raise ValueError("unavailable evidence cannot carry a value")
        return self


class EvidenceItem(EvidenceValue):
    id: EvidenceId


def _digest(value: object) -> str:
    return sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def publication_within(value: datetime | date | None, cutoff: datetime) -> bool:
    """Date-only sources retain their precision; an observation bounds the time."""
    if value is None:
        return True
    return (
        value <= cutoff if isinstance(value, datetime) else value <= cutoff.astimezone(UTC).date()
    )


def evidence_item(binding: EvidenceBinding, value: EvidenceValue) -> EvidenceItem:
    payload = value.model_dump(mode="json")
    # Same row in the same workspace and pinned run keeps its ID when the
    # caller changes the cutoff or gets a narrower field grant.
    key = [binding.workspace_id, binding.snapshot_run_id, payload]
    return EvidenceItem.model_validate({**payload, "id": "ve_" + _digest(key)})


class FrozenValuationEvidence(_FrozenModel):
    """Self-contained replay input; validate again on deserialization."""

    binding: EvidenceBinding
    formula_version: Literal[VALUATION_FORMULA_VERSION] = VALUATION_FORMULA_VERSION
    eligibility: Literal["equity", "fund", "financial", "unknown"]
    facts_version: Version | None = None
    quote_id: Version | None = None
    rows: tuple[EvidenceItem, ...] = Field(max_length=MAX_EVIDENCE_ROWS)

    @model_validator(mode="after")
    def check_scope(self) -> Self:
        if len(self.model_dump_json().encode()) > MAX_EVIDENCE_BYTES:
            raise EvidenceLimitError("frozen valuation evidence exceeds the byte limit")
        binding = self.binding
        seen: set[str] = set()
        basis: set[Metric] = set()
        for row in self.rows:
            if (row.ticker, row.listing) != (binding.ticker, binding.listing):
                raise EvidenceScopeError("evidence listing mismatch")
            if row.metric not in binding.permitted_fields:
                raise EvidenceScopeError("evidence field is not permitted")
            if (
                row.observed_at is not None and row.observed_at > binding.cutoff
            ) or not publication_within(row.published_at, row.observed_at or binding.cutoff):
                raise EvidenceScopeError("evidence is newer than the cutoff or observation time")
            if (
                row.id
                != evidence_item(
                    binding, EvidenceValue.model_validate(row.model_dump(exclude={"id"}))
                ).id
                or row.id in seen
            ):
                raise EvidenceScopeError("invalid or duplicate evidence ID")
            seen.add(row.id)
            if row.group == EvidenceGroup.BASIS:
                if row.metric in basis or row.metric not in BASIS_METRICS:
                    raise EvidenceScopeError("invalid or duplicate valuation basis field")
                basis.add(row.metric)
        return self

    def resolve(self, evidence_id: EvidenceId) -> EvidenceItem:
        """Resolve an ID only in this bundle's authorized local catalog."""
        for row in self.rows:
            if row.id == evidence_id:
                return row
        raise EvidenceScopeError("unknown valuation evidence citation")


class EvidenceResult(_FrozenModel):
    state: State
    reason: Reason | None = None
    items: tuple[EvidenceItem, ...] = ()


class BasisResult(EvidenceResult):
    basis: FrozenValuationBasis | None = None


class ProposedScenario(ScenarioInputs):
    model_config = ConfigDict(
        strict=True, frozen=True, allow_inf_nan=False, hide_input_in_errors=True
    )


class ProposedScenarios(_FrozenModel):
    bear: ProposedScenario
    base: ProposedScenario
    bull: ProposedScenario


class AssumptionCitation(_FrozenModel):
    scenario: Scenario
    assumption: Assumption
    evidence_id: EvidenceId


class EvaluateValuationRequest(_FrozenModel):
    horizon: Literal[5, 10] = 5
    scenarios: ProposedScenarios
    citations: tuple[AssumptionCitation, ...] = Field(default=(), max_length=15)


class ReverseDCF(_FrozenModel):
    implied_growth: float | None
    bound: Literal["below", "above"] | None
    reason: Literal["non-monotonic-or-flat-cashflows"] | None
    search_bounds: tuple[float, float] = REVERSE_GROWTH_BOUNDS


class ValuationEvaluation(_FrozenModel):
    state: State
    reason: Reason | None = None
    formula_version: Literal[VALUATION_FORMULA_VERSION] = VALUATION_FORMULA_VERSION
    preview_id: PreviewId | None = None
    horizon: Literal[5, 10]
    projections: dict[Scenario, ScenarioProjection] | None = None
    sensitivity: tuple[SensitivityCell, ...] = ()
    reverse_dcf: ReverseDCF | None = None
    warnings: tuple[
        Literal[
            "equity-cash-flow-proxy",
            "reverse-dcf-withheld",
            "reverse-dcf-outside-bounds",
            "cross-currency-stored-share-basis",
        ],
        ...,
    ] = ()
    basis_evidence_ids: tuple[EvidenceId, ...] = ()
    citations: tuple[AssumptionCitation, ...] = ()


CITABLE_METRICS: dict[Assumption, frozenset[Metric]] = {
    "revenue_cagr": frozenset(
        {
            Metric.REVENUE,
            Metric.REVENUE_GROWTH,
            Metric.CONSENSUS_REVENUE,
            Metric.CONSENSUS_REVENUE_GROWTH,
            Metric.CONSENSUS_REVENUE_GROWTH_CHANGE,
        }
    ),
    "target_fcf_margin": frozenset(
        {
            Metric.REVENUE,
            Metric.FREE_CASHFLOW,
            Metric.FCF_MARGIN,
            Metric.CASH_FROM_OPERATIONS,
            Metric.CAPEX,
        }
    ),
    "discount_rate": frozenset({Metric.COST_OF_EQUITY}),
    # The vendor multiples have different denominators. They are context only.
    "exit_fcf_multiple": frozenset(),
    "share_cagr": frozenset({Metric.SHARES, Metric.STATEMENT_SHARES}),
}


class ValuationEvidenceTools:
    """Five bound tool methods. One instance meters a single call batch."""

    def __init__(self, binding: EvidenceBinding, evidence: FrozenValuationEvidence) -> None:
        # Revalidate even an internally constructed model_copy; nested state
        # used for execution is independent of the caller's Python objects.
        self._frozen = FrozenValuationEvidence.model_validate(evidence.model_dump(mode="json"))
        if self._frozen.binding != binding:
            raise EvidenceScopeError("frozen evidence does not match the binding")
        self._lock = Lock()
        self._calls = self._rows = 0
        self._bytes = 2  # brackets enclosing an entire serialized response batch

    def _deliver[T: _FrozenModel](self, response: T, *, rows: int) -> T:
        size = len(response.model_dump_json().encode()) + 1  # reserve comma
        with self._lock:
            if (
                self._calls >= MAX_BATCH_CALLS
                or self._rows + rows > MAX_BATCH_ROWS
                or self._bytes + size > MAX_EVIDENCE_BYTES
            ):
                raise EvidenceLimitError("valuation tool batch budget exceeded")
            self._calls += 1
            self._rows += rows
            self._bytes += size
        return response

    def _group(self, group: EvidenceGroup) -> tuple[EvidenceItem, ...]:
        return tuple(row for row in self._frozen.rows if row.group == group)

    def _read_group(self, group: EvidenceGroup) -> EvidenceResult:
        items = self._group(group)
        available = any(item.state == "available" for item in items)
        return self._deliver(
            EvidenceResult(
                state="available" if available else "missing",
                reason=None if available else "no-evidence",
                items=items,
            ),
            rows=len(items),
        )

    def _basis(self) -> BasisResult:
        items = self._group(EvidenceGroup.BASIS)
        fields = {item.metric: item for item in items if item.state == "available"}
        if not self._frozen.binding.permitted_fields >= BASIS_METRICS:
            return BasisResult(state="missing", reason="fields-not-permitted", items=items)
        if self._frozen.eligibility in {"fund", "financial"}:
            return BasisResult(
                state="unsupported", reason="cashflow-model-not-applicable", items=items
            )
        if self._frozen.eligibility == "unknown":
            return BasisResult(state="missing", reason="listing-identity-unavailable", items=items)
        if not (BASIS_METRICS - {Metric.FX}) <= fields.keys():
            return BasisResult(
                state="missing",
                reason="complete-ttm-currency-and-share-count-required",
                items=items,
            )
        if Metric.FX not in fields:
            return BasisResult(
                state="missing", reason="currency-conversion-unavailable", items=items
            )
        spot, shares, fx, revenue, fcf = (
            fields[m]
            for m in (Metric.SPOT, Metric.SHARES, Metric.FX, Metric.REVENUE, Metric.FREE_CASHFLOW)
        )
        if (
            spot.currency is None
            or revenue.currency is None
            or fcf.currency != revenue.currency
            or fx.currency != revenue.currency
            or fx.counter_currency != spot.currency
            or revenue.period != fcf.period
            or revenue.period.kind != "ttm"
            or len(revenue.period.component_ends) != 4
            or not self._frozen.facts_version
            or not self._frozen.quote_id
        ):
            raise EvidenceScopeError("inconsistent valuation basis")
        if any(item.value is None for item in (spot, shares, fx, revenue, fcf)):
            raise EvidenceScopeError("incomplete valuation basis")
        if spot.value <= 0 or shares.value <= 0 or fx.value <= 0 or revenue.value <= 0:
            raise EvidenceScopeError("invalid valuation basis")
        if fcf.value <= 0:
            return BasisResult(
                state="unsupported",
                reason="non-positive-starting-free-cash-flow",
                items=items,
            )
        margin = fcf.value / revenue.value
        if margin > 1:
            return BasisResult(
                state="unsupported",
                reason="starting-margin-outside-formula-bounds",
                items=items,
            )
        converted = revenue.value * fx.value
        if not 0 < converted < float("inf"):
            return BasisResult(
                state="unsupported",
                reason="projection-outside-numeric-range",
                items=items,
            )
        basis = FrozenValuationBasis(
            ticker=self._frozen.binding.ticker,
            quote_id=self._frozen.quote_id,
            data_version=fingerprint([self._frozen.facts_version, self._frozen.quote_id]),
            currency=spot.currency,
            spot=spot.value,
            spot_as_of=spot.published_at.astimezone(UTC).isoformat()
            if isinstance(spot.published_at, datetime)
            else spot.period.end.isoformat()
            if spot.period.end
            else None,
            revenue=converted,
            shares=shares.value,
            start_margin=margin,
        )
        return BasisResult(state="available", items=items, basis=basis)

    def get_valuation_basis(self) -> BasisResult:
        """Return the public quote, shares, FX and statement inputs used by the engine."""
        result = self._basis()
        return self._deliver(result, rows=len(result.items))

    def get_operating_evidence(self) -> EvidenceResult:
        """Return recent statement observations with reporting periods and versions."""
        return self._read_group(EvidenceGroup.OPERATING)

    def get_expectations_and_changes(self) -> EvidenceResult:
        """Return consensus and only comparable, identified revisions."""
        return self._read_group(EvidenceGroup.EXPECTATIONS)

    def get_market_references(self) -> EvidenceResult:
        """Return public context; these references do not set model inputs."""
        return self._read_group(EvidenceGroup.MARKET)

    def evaluate_valuation(self, request: EvaluateValuationRequest) -> ValuationEvaluation:
        """Run the existing DCF with proposed scenarios; do not save anything."""
        request = EvaluateValuationRequest.model_validate(request.model_dump(mode="json"))
        cited = set()
        for citation in request.citations:
            key = (citation.scenario, citation.assumption, citation.evidence_id)
            row = self._frozen.resolve(citation.evidence_id)
            if (
                key in cited
                or row.state != "available"
                or row.metric not in CITABLE_METRICS[citation.assumption]
            ):
                raise EvidenceScopeError("unknown, unavailable, duplicate or mismatched citation")
            cited.add(key)

        frozen_basis = self._basis()
        if frozen_basis.basis is None:
            return self._deliver(
                ValuationEvaluation(
                    state=frozen_basis.state, reason=frozen_basis.reason, horizon=request.horizon
                ),
                rows=0,
            )
        basis_ids = tuple(sorted(row.id for row in frozen_basis.items))
        citations = tuple(
            sorted(request.citations, key=lambda c: (c.scenario, c.assumption, c.evidence_id))
        )
        inputs = ValuationPreviewRequest(
            horizon=request.horizon,
            scenarios={
                "bear": request.scenarios.bear,
                "base": request.scenarios.base,
                "bull": request.scenarios.bull,
            },
        )
        basis = frozen_basis.basis
        # Refuse non-finite projections instead of JSON silently turning them
        # into null. Scenario bounds alone do not bound the provider's scale.
        try:
            result = preview(basis, inputs)
            preview_id = "vp_" + _digest(
                [
                    result.formula_version,
                    basis_ids,
                    basis.model_dump(mode="json"),
                    inputs.model_dump(mode="json"),
                    [c.model_dump(mode="json") for c in citations],
                    result.model_dump(mode="python"),
                ]
            )
        except (ValueError, ArithmeticError):
            return self._deliver(
                ValuationEvaluation(
                    state="unsupported",
                    reason="projection-outside-numeric-range",
                    horizon=request.horizon,
                ),
                rows=0,
            )
        warnings = ["equity-cash-flow-proxy"]
        if any(
            row.metric == Metric.FX and row.basis == "stored-valuation-fx"
            for row in frozen_basis.items
        ):
            warnings.append("cross-currency-stored-share-basis")
        if result.implied_growth_reason:
            warnings.append("reverse-dcf-withheld")
        if result.implied_growth_bound:
            warnings.append("reverse-dcf-outside-bounds")
        return self._deliver(
            ValuationEvaluation(
                state="available",
                preview_id=preview_id,
                horizon=result.horizon,
                projections=result.scenarios,
                sensitivity=tuple(result.sensitivity),
                reverse_dcf=ReverseDCF(
                    implied_growth=result.implied_growth,
                    bound=result.implied_growth_bound,
                    reason=result.implied_growth_reason,
                ),
                warnings=tuple(warnings),
                basis_evidence_ids=basis_ids,
                citations=citations,
            ),
            rows=len(result.sensitivity)
            + sum(len(scenario.years) for scenario in result.scenarios.values()),
        )
