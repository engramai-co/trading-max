"""Shared family-aware v2 valuation calculation over one publication."""

from fastapi import HTTPException, Request
from trading_max.research.facts import number
from trading_max.research.fundamentals import sector_profile_by_label
from trading_max.research.statement_valuation import freeze_basis, scenario_defaults
from trading_max.research.valuation_basis import EXCLUDED_ASSETS, Family, classify
from trading_max.research.valuation_preview import (
    LEGACY_VERSION,
    ScenarioInputs,
    ValuationPreview,
    ValuationPreviewRequest,
    preview,
)

from ..models import SnapshotManifest
from ..valuation_preview_v1 import OperatingScenarioInputs
from .dependencies import app_service, latest_or_503


def family_valuation_preview(
    ticker: str,
    request: Request,
    inputs: ValuationPreviewRequest | None = None,
    requested_family: Family | None = None,
    manifest: SnapshotManifest | None = None,
    *,
    legacy: bool = False,
) -> ValuationPreview:
    default_source = "user-input"
    research = app_service(request, "research")
    manifest = manifest or latest_or_503(request)
    lens = research.lens_snapshot(ticker, "valuation", manifest)
    facts, context = lens.financial_facts, lens.context
    if not facts or not context or not lens.valuation:
        raise HTTPException(status_code=422, detail="valuation-inputs-unavailable")
    if context.asset_type in EXCLUDED_ASSETS:
        raise HTTPException(status_code=422, detail="company-model-not-applicable")
    stored = lens.valuation.assumptions
    quote = context.quote
    saved = app_service(request, "research_journal").load(ticker).models if inputs is None else []
    latest = saved[0].preview if saved else None
    if latest and requested_family is not None and latest.basis.family != requested_family:
        latest = None
    auto = stored.get("family") or classify(ticker, "", {})[0]
    family = (inputs.family if inputs else requested_family) or (
        latest.basis.family if latest else auto
    )
    # The data version stays tied to the research quote so a broker refresh
    # never invalidates an edit in progress.
    held = research.held_position(ticker, manifest)
    # Only the same listing in the same currency: a line on another market or a
    # ``.L`` alias is a different price, even in the quote's currency.
    broker_spot = (
        held is not None
        and held.get("listing") is not None
        and held["listing"] == quote.listing
        and held["currency"] == quote.currency
    )
    try:
        basis = freeze_basis(
            facts,
            family,
            ticker=ticker,
            spot=held["price"] if broker_spot else quote.price,
            currency=quote.currency,
            shares=number(stored.get("quotedSharesOutstanding") or stored.get("sharesOutstanding")),
            fx=number(stored.get("fxRate"))
            if lens.valuation.currency == quote.currency
            and stored.get("financialFactsVersion") in {None, facts.version}
            else None,
            quote_id=quote.id,
            listing=quote.listing,
            name=stored.get("issuerName") or "",
            is_adr=bool(stored.get("isAdr")),
            ordinary_listing=stored.get("shareUnit") == "ordinary"
            and stored.get("listing") == quote.listing,
        )
        basis.spot_source = "broker" if broker_spot else "quote"
        basis.spot_as_of = held["asOf"] if broker_spot else quote.as_of
        if inputs is None:
            if latest and latest.scenarios:
                inputs = ValuationPreviewRequest(
                    scenarios={k: v.inputs for k, v in latest.scenarios.items()},
                    family=family,
                    horizon=latest.horizon,
                    references=latest.references,
                    formula_version=latest.formula_version,
                )
                default_source = "saved-model"
            else:
                profile = sector_profile_by_label(stored.get("profile"))
                cost = number(stored.get("discountRate")) or profile.discount
                scenarios, references = scenario_defaults(basis, facts, profile, cost)
                same_family = family == auto
                if same_family and lens.valuation.scenarios:
                    scenarios = {
                        key: ScenarioInputs.model_validate(
                            {
                                **scenarios[key].model_dump(by_alias=False),
                                **value.model_dump(
                                    by_alias=False,
                                    exclude_none=True,
                                    include=set(ScenarioInputs.model_fields),
                                ),
                            }
                        )
                        for key, value in lens.valuation.scenarios.items()
                        if key in scenarios
                    }
                default_source = (
                    "sector-template"
                    if not same_family or stored.get("assumptionSource") == "sector-template"
                    else "configured-scenarios"
                )
                company = next(
                    (
                        c
                        for c in app_service(request, "valuation_assumptions").load().companies
                        if c.ticker.upper() == ticker.upper() and c.source == "manual"
                    ),
                    None,
                )
                if company and company.family == family:
                    default_source = "configured-scenarios"
                    for key, value in company.scenarios.items():
                        if key in scenarios:
                            scenarios[key] = ScenarioInputs.model_validate(
                                {
                                    **scenarios[key].model_dump(by_alias=False),
                                    **value.model_dump(by_alias=False, exclude_none=True),
                                }
                            )
                if default_source != "sector-template":
                    references = []
                for ref in references:
                    ref.value = scenarios[ref.scenario].revenue_cagr
                    ref.adjustment = ref.value - ref.reference_value
                inputs = ValuationPreviewRequest(
                    scenarios=scenarios, family=family, references=references
                )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        if legacy:
            if (
                basis.family != "cash-flow"
                or not basis.revenue
                or not -1 <= basis.start_margin <= 1
            ):
                raise ValueError("family-aware-valuation-preview-required")
            inputs = inputs.model_copy(
                update={
                    "formula_version": LEGACY_VERSION,
                    "scenarios": {
                        key: ScenarioInputs.model_validate(
                            OperatingScenarioInputs.model_validate(
                                params, from_attributes=True
                            ).model_dump()
                        )
                        for key, params in inputs.scenarios.items()
                    },
                }
            )
        result = preview(basis, inputs)
        result.default_source = default_source
        result.family_selection = (
            "override"
            if requested_family
            or family != auto
            or (latest and latest.family_selection == "override")
            else "automatic"
        )
        return result
    except ValueError as exc:
        raise HTTPException(
            status_code=409 if str(exc) == "research-data-version-changed" else 422, detail=str(exc)
        ) from exc
