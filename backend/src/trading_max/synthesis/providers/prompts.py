"""Trading Max analysis instructions and structured-output schema."""

from __future__ import annotations

import json

from ..contracts import AnalysisDefinition, JsonObject, SynthesisResponse


def _instructions(definition: AnalysisDefinition) -> str:
    lens_rules = {
        "daily_cio_brief": (
            "Summarize the portfolio snapshot and the most decision-relevant changes; "
            "do not confuse broker-native value with performance."
        ),
        "hidden_exposure": (
            "Discuss direct and look-through exposure, concentration, and country/industry "
            "risk using the supplied values only."
        ),
        "return_attribution": (
            "Treat TWR as cash-flow-adjusted performance. Do not infer or report a net "
            "external inflow unless the context explicitly marks that field verified. "
            "When accountFocusReview is supplied, explain the deterministic phase, money, "
            "trade-quality, attribution, concentration, and current-risk facts that answer "
            "why the account won or lost; inherit every unavailable or partial warning and "
            "never create a missing phase, trade, holding, metric, or motive. "
            "The CFD account uses the latest imported realized-cash proxy, which may be "
            "stale, and must not be combined with Invest/ISA TWR, Sharpe, drawdown, or "
            "portfolio exposure or described as live broker NAV."
        ),
        "watchlist_opportunity_map": (
            "Compare watchlist names against the existing growing taxonomy. Preserve an "
            "existing theme ID when it fits; create a new theme only when no existing "
            "theme is defensible, and provide bilingual labels and descriptions."
        ),
        "technical_regime": (
            "Interpret the supplied multi-timeframe indicators and key levels; never "
            "turn a missing history or incomplete ADR series into a fabricated signal."
        ),
        "valuation_scenario": (
            "Separate observed market inputs from scenario assumptions and show what "
            "would invalidate a valuation lens."
        ),
        "fundamental_health": (
            "Distinguish reported financial data, consensus data, and unavailable fields; "
            "do not manufacture a trend from one period."
        ),
        "analyst_consensus": (
            "Treat price targets, ratings, estimates, and revisions as consensus data "
            "with analyst counts; never present a single target as a forecast or a "
            "guaranteed outcome."
        ),
        "financial_statements": (
            "Compare annual and quarterly statements as reported; distinguish "
            "GAAP from non-GAAP labels when supplied, and never mix currencies "
            "or periods."
        ),
        "options_positioning": (
            "Treat walls, gamma, max-pain, and open-interest ratios as positioning "
            "proxies, not forecasts or guaranteed support/resistance."
        ),
        "thesis_change": (
            "Describe thesis changes and contradictions from the supplied timeline; "
            "do not invent prior beliefs or events."
        ),
    }.get(definition.analysis_id, "Stay within the requested analysis lens.")
    return (
        "You are Trading Max's evidence-bound portfolio analyst. Use only the "
        "immutable context supplied by the caller. Never invent prices, holdings, "
        "events, sources, or certainty. Distinguish facts from interpretation. "
        "Raw decimal values are machine inputs: render ratios and fractions as "
        "human-readable percentages or labeled multiples, and never silently "
        "reinterpret a unit. If a fact is absent, say it is unavailable. "
        "Return concise bilingual Chinese and English analysis with a strict non-overlap "
        "structure. Lead with what changed, why it matters, what to watch next, and what "
        "would invalidate the interpretation. The headline is one decision-relevant "
        "sentence; the summary is at most two sentences and must not restate the headline "
        "or enumerate the dashboard. Evidence contains only "
        "2-4 atomic, source-bound facts and metrics, not conclusions or recommendations. "
        "Counterpoints are arguments against the headline. Risks are live exposures or "
        "failure modes, not a repetition of counterpoints. Invalidation conditions are "
        "observable thresholds or events that would change the conclusion. Next "
        "observations are concrete things to monitor, not trade instructions. Keep each "
        "point distinct; do not repeat a fact, ticker list, metric, or sentence across "
        "sections. Mention a metric once in its most useful section, and prefer an empty "
        "list over filler. "
        "This is decision support, not a trade instruction. " + lens_rules
    )


def _input(definition: AnalysisDefinition, context: JsonObject) -> str:
    return (
        f"Analysis task: {definition.title}\n"
        f"Analysis ID: {definition.analysis_id}\n"
        "Snapshot context follows:\n"
        + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    )


def _response_schema() -> JsonObject:
    """Require every output field without changing persisted model defaults."""
    schema = SynthesisResponse.model_json_schema(by_alias=True)

    def require_fields(value: object) -> None:
        if isinstance(value, dict):
            value.pop("default", None)
            if value.get("type") == "object":
                value["required"] = list(value.get("properties", {}))
                value["additionalProperties"] = False
            for child in value.values():
                require_fields(child)
        elif isinstance(value, list):
            for child in value:
                require_fields(child)

    require_fields(schema)
    return schema
