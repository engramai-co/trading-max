"""Shared statement inputs, scenario defaults and batch output for the Research Desk."""

from collections.abc import Mapping
from datetime import date
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .fundamentals import _SectorProfile

from trading_max.reference.quote_units import major_quote_unit
from trading_max.reference.venues import venue_mic

from .facts import FinancialFacts, fingerprint, number
from .listing import REVIEWED_ORDINARY_SOURCES, REVIEWED_RECEIPTS
from .valuation_basis import (
    EXCLUDED_ASSETS,
    Family,
    listing_shares,
    period_choice,
    share_unit,
    statement_basis,
)
from .valuation_preview import (
    VALUATION_FORMULA_VERSION,
    AssumptionReference,
    FrozenValuationBasis,
    ScenarioInputs,
    ValuationPreviewRequest,
    preview,
    project,
)


def freeze_basis(
    facts: FinancialFacts,
    family: Family,
    *,
    ticker: str,
    spot: float,
    currency: str,
    shares: float | None,
    fx: float | None,
    quote_id: str,
    listing: str | None,
    name: str = "",
    is_adr: bool = False,
    ordinary_listing: bool = False,
    legacy_reasons: bool = False,
) -> FrozenValuationBasis:
    period, values = statement_basis(facts, family, listing)
    # A class or receipt can require a share count in the same period. A complete
    # book and earnings period without that count keeps the missing-shares reason.
    if (
        family == "residual-income"
        and not period
        and (legacy_reasons or not listing or not statement_basis(facts, family)[0])
    ):
        raise ValueError("positive-common-equity-and-common-income-required")
    if not period or not currency or not facts.currency or not spot or spot <= 0:
        raise ValueError("complete-ttm-currency-and-share-count-required")
    shares, ratio = listing_shares(ticker, listing, name, shares, values, is_adr, ordinary_listing)
    if not shares or shares <= 0:
        if not legacy_reasons and listing and ratio is None:
            if is_adr:
                raise ValueError("receipt-ratio-unverified")
            if not ordinary_listing:
                raise ValueError("listed-share-unit-unverified")
        raise ValueError("complete-ttm-currency-and-share-count-required")
    if facts.currency == currency:
        fx = 1
    if not fx or fx <= 0:
        raise ValueError("currency-conversion-unavailable")
    income = values.get("commonIncome") or values.get("netIncome")
    flow = values.get("freeCashflow") if family == "cash-flow" else income
    revenue = values["revenue"].value if "revenue" in values else None
    book = values.get("commonEquity") if family == "residual-income" else None
    cash = values.get("cash") if family == "cash-flow" else None
    return FrozenValuationBasis(
        ticker=ticker,
        quote_id=quote_id,
        data_version=fingerprint([facts.version, quote_id]),
        currency=currency,
        reporting_currency=facts.currency,
        fx_rate=fx,
        spot=spot,
        shares=shares,
        period_id=period.id,
        period_choice=period_choice(facts, period),
        family=family,
        revenue=revenue * fx if revenue is not None and revenue >= 0 else None,
        common_earnings=income.value * fx if family == "residual-income" and income else None,
        start_margin=flow.value / revenue
        if family != "residual-income" and flow and revenue
        else 0,
        opening_cash=cash.value * fx if cash and cash.value >= 0 else None,
        book_per_share=book.value * fx / shares if book and book.value > 0 else None,
        ordinary_per_receipt=ratio,
        cash_flow_type={
            "cash-flow": "operating-cash-flow-less-capex-equity-proxy",
            "net-income": "net-income-proxy",
            "residual-income": "residual-income",
        }[family],
        evidence=[
            e
            for o in (
                values.get("revenue"),
                flow,
                cash if family == "cash-flow" else None,
                book if family == "residual-income" else None,
                values.get("ordinaryShares"),
            )
            if o
            for e in o.evidence
        ],
    )


def annualised_change(first: float, last: float, first_day: date, last_day: date) -> float | None:
    years = (last_day - first_day).days / 365.25
    if years < 0.9 or min(first, last) <= 0:
        return None
    return (last / first) ** (1 / years) - 1


def annual_growth(facts: FinancialFacts) -> tuple[float | None, list[AssumptionReference]]:
    revenues = {
        o.period_id: o
        for o in facts.observations
        if o.metric == "revenue" and o.value is not None and o.value > 0
    }
    annual = sorted(
        (p for p in facts.periods if p.kind == "annual" and p.id in revenues),
        key=lambda p: p.provider_end,
    )[-4:]
    if len(annual) < 2:
        return None, []
    first, last = annual[0], annual[-1]
    a, b = revenues[first.id], revenues[last.id]
    growth = annualised_change(
        a.value,
        b.value,
        date.fromisoformat(first.provider_end),
        date.fromisoformat(last.provider_end),
    )
    if growth is None:
        return None, []
    return growth, [
        AssumptionReference(
            scenario=key,
            period=f"{first.label} → {last.label}",
            as_of=last.actual_end or last.provider_end,
            value=growth,
            reference_value=growth,
            source="historical-revenue-cagr",
            evidence=[*a.evidence, *b.evidence],
        )
        for key in ("bear", "base", "bull")
    ]


def scenario_defaults(
    basis: FrozenValuationBasis,
    facts: FinancialFacts,
    profile: "_SectorProfile",
    cost: float,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
):
    growth, references = (None, []) if basis.family == "residual-income" else annual_growth(facts)
    defaults = scenario_template_inputs(basis, profile, cost, growth, overrides)
    if overrides or basis.family == "residual-income":
        return defaults, []
    for ref in references:
        ref.value = defaults[ref.scenario].revenue_cagr
        ref.adjustment = ref.value - growth
    return defaults, references


def scenario_template_inputs(
    basis: FrozenValuationBasis,
    profile: "_SectorProfile",
    cost: float,
    growth: float | None,
    overrides: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, ScenarioInputs]:
    from .fundamentals import _scenario_params

    growth_base = max(-0.1, min(profile.growth_cap, growth)) if growth is not None else None
    margin = min(basis.start_margin, profile.margin_cap)
    if margin < 0.03:
        margin = profile.margin_cap * 0.6
    defaults = {}
    for key, shift in (("bear", -0.05), ("base", 0.0), ("bull", 0.05)):
        params = _scenario_params(
            key,
            base_growth=growth_base,
            reported_growth=growth,
            start_margin=margin,
            profile=profile,
            wacc=cost,
            legacy=overrides,
        )
        ramp = (
            (5 if profile.label in {"semiconductors", "hardware", "power-industrial"} else 4)
            if basis.start_margin < 0.03
            else 3
        )
        fields = {
            "revenue_cagr": params["growth"],
            "target_fcf_margin": params["margin"],
            "discount_rate": params["discount"],
            "exit_fcf_multiple": params["exitMultiple"],
            "share_cagr": params["shareCagr"],
            "ramp_years": ramp,
        }
        if basis.family == "residual-income":
            # Reported annualised common earnings divided by period-end common equity.
            roe = basis.common_earnings / (basis.book_per_share * basis.shares)
            fields = {
                "discount_rate": fields["discount_rate"],
                "initial_roe": max(-0.8, min(2, roe + shift)),
                "payout": 0.3,
                "terminal_pb": 1 + shift * 5,
            }
        params = ScenarioInputs.model_validate(fields)
        if overrides and key in overrides:
            updated = params.model_dump(by_alias=False)
            for field, definition in ScenarioInputs.model_fields.items():
                specified = overrides[key].get(field, overrides[key].get(definition.alias))
                if specified is not None:
                    updated[field] = specified
            params = ScenarioInputs.model_validate(updated)
        defaults[key] = params
    return defaults


def statement_row(
    ticker: str,
    facts: FinancialFacts,
    *,
    family: Family,
    classification: str,
    fundamental: Mapping[str, Any],
    spot: float | None,
    profile: "_SectorProfile",
    cost: float,
    discount_inputs: dict[str, Any],
    overrides: Mapping[str, Mapping[str, Any]] | None,
    source: str,
    fx: float | None,
    shares: float | None,
    currency: str,
    listing: str | None,
    security_type: str,
    filing_evidence: Mapping[str, Any],
) -> dict[str, Any]:
    from .fundamentals import _valuation_range_position

    metrics = fundamental.get("metrics") or {}
    name = fundamental.get("name") or ""
    filed_units = filing_evidence.get("listedShareUnits") or {}
    unit = share_unit(listing, filed_units, security_type)
    is_adr = unit == "receipt"
    ordinary_listing = unit == "ordinary"
    receipt = REVIEWED_RECEIPTS.get(listing)
    source_url = (
        filing_evidence.get("shareUnitFiling")
        if filed_units.get(listing)
        else REVIEWED_ORDINARY_SOURCES.get(listing) or (receipt.source if receipt else None)
    )
    stored = {
        "family": family,
        "classification": classification,
        "sharesOutstanding": shares,
        "fxRate": fx,
        "financialFactsVersion": facts.version,
        "profile": profile.label,
        "assumptionSource": source,
        "discountRate": cost,
        "discountRateInputs": discount_inputs,
        "listing": listing,
        "shareUnitFiling": source_url,
        "shareUnitVenue": venue_mic(metrics.get("fullExchangeName")),
        "issuerName": name,
        "isAdr": is_adr,
        "shareUnit": unit,
        "cashflowReconciliation": facts.reconciliation,
    }
    _, divisor = major_quote_unit(fundamental.get("currency") or "")
    analyst = number(metrics.get("targetMedianPrice") or metrics.get("targetMeanPrice"))
    row = {
        "ticker": ticker,
        "currency": currency,
        "price": spot,
        "ev5": None,
        "ev10": None,
        "model_status": "unavailable",
        "model_warnings": [],
        "assumptions": stored,
        "method": "unavailable",
        "verdict": "not-covered",
        "source": "trading-max-statement-valuation-v2",
        "impl": None,
        "med": analyst / divisor if analyst else None,
        "lenses": {
            k: metrics.get(k)
            for k in (
                "trailingPE",
                "forwardPE",
                "priceToSalesTrailing12Months",
                "priceToBook",
                "enterpriseToEbitda",
            )
        },
    }
    stored["startingRevenue"] = None
    if metrics.get("quoteType") in EXCLUDED_ASSETS:
        return row
    try:
        basis = freeze_basis(
            facts,
            family,
            ticker=ticker,
            spot=spot,
            currency=currency,
            shares=shares,
            fx=fx,
            quote_id=fingerprint([spot, currency]),
            listing=listing,
            name=name,
            is_adr=is_adr,
            ordinary_listing=ordinary_listing,
        )
        scenarios, _ = scenario_defaults(basis, facts, profile, cost, overrides)
        five = preview(basis, ValuationPreviewRequest(scenarios=scenarios))
        ten = {k: project(basis, p, 10) for k, p in scenarios.items()} if five.scenarios else {}
    except (ValueError, ArithmeticError) as exc:
        row["model_warnings"] = [str(exc)]
        return row
    stored.update(
        quotedSharesOutstanding=shares,
        sharesOutstanding=basis.shares,
        periodId=basis.period_id,
        startingRevenue=basis.revenue,
        freeCashflowMargin=basis.start_margin,
        cashFlowType=basis.cash_flow_type,
        ordinaryPerReceipt=basis.ordinary_per_receipt,
        ordinaryPerReceiptSource=receipt.source if receipt else None,
        formulaVersion=VALUATION_FORMULA_VERSION,
        reverseMetric=five.reverse_metric,
        reverseValue=five.reverse_value,
        reverseBound=five.reverse_bound,
        reverseReason=five.reverse_reason,
    )
    stored["reportingCurrency"] = facts.currency
    stored["discountRateType"] = "cost-of-equity"
    _, selected = statement_basis(facts, family, listing)
    stored["inputEvidence"] = {
        metric: obs.model_dump(mode="json")
        for metric, obs in selected.items()
        if metric
        in {
            "revenue",
            "cash",
            "commonIncome",
            "commonEquity",
            "netIncome",
            "freeCashflow",
            "ordinaryShares",
        }
        and obs.evidence
        and any(ref in basis.evidence for ref in obs.evidence)
    }
    row["valuationPolicy"] = {
        "cashFlowType": basis.cash_flow_type,
        "discountRateType": "cost-of-equity",
        "terminalMethod": {
            "cash-flow": "exit-fcf-multiple",
            "net-income": "exit-earnings-multiple",
            "residual-income": "terminal-price-to-book",
        }[family],
        "selectedHorizonYears": 5,
        "analystTargetsAreReferenceOnly": True,
        "validationStatus": "not-backtested",
    }
    row.update(
        scenarios={
            k: {
                **p.model_dump(exclude_none=True),
                "value": five.scenarios[k].value if k in five.scenarios else None,
                "value10": ten[k].value if k in ten else None,
            }
            for k, p in scenarios.items()
        },
        method=family,
        impl=five.implied_growth,
        implBound=five.implied_growth_bound,
    )
    if not five.scenarios:
        row["model_warnings"] = ["zero-revenue-reverse-only"]
        return row
    ranges = {k: v.value for k, v in five.scenarios.items()}
    row.update(
        ev5=ranges["base"],
        ev10=ten["base"].value,
        model_status="indicative",
        valueRange=ranges,
        valueRange10={k: v.value for k, v in ten.items()},
        verdict=_valuation_range_position(spot=spot, value_range=ranges, has_model=True),
        base_g=scenarios["base"].revenue_cagr if family != "residual-income" else None,
    )
    if family == "cash-flow":
        base = scenarios["base"]
        margin_deltas = [-0.05, -0.02, 0, 0.02, 0.05]
        try:
            margins = [
                project(
                    basis,
                    base.model_copy(
                        update={
                            "target_fcf_margin": min(1, max(-1, base.target_fcf_margin + delta))
                        }
                    ),
                    5,
                ).value
                for delta in margin_deltas
            ]
        except ValueError as exc:
            if str(exc) != "opening-cash-required-for-burn":
                raise
        else:
            row["sensitivity"] = {
                "discountRate": {
                    "deltas": [
                        cell.discount_rate - base.discount_rate for cell in five.sensitivity[2::5]
                    ],
                    "values": [cell.value for cell in five.sensitivity[2::5]],
                },
                "revenueGrowth": {
                    "deltas": [cell.growth - base.revenue_cagr for cell in five.sensitivity[10:15]],
                    "values": [cell.value for cell in five.sensitivity[10:15]],
                },
                "fcfMargin": {"deltas": margin_deltas, "values": margins},
            }
    if family != "residual-income":
        base = scenarios["base"]
        if base.discount_rate > 0.03:
            multiple = 1.03 / (base.discount_rate - 0.03)
            gordon = project(basis, base.model_copy(update={"exit_fcf_multiple": multiple}), 5)
            row["terminalCheck"] = {
                "gordonMultiple": multiple,
                "exitMultiple": base.exit_fcf_multiple,
                "gordonValue": gordon.value,
                "consistent": abs(base.exit_fcf_multiple / multiple - 1) < 0.5,
            }
    return row
