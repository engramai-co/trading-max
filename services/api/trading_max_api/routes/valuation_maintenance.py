"""Compare a saved valuation with the current statements, price and proposal."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from trading_max.research.facts import number
from trading_max.research.valuation_evidence import Metric
from trading_max.research.valuation_maintenance import (
    ValuationMaintenance,
    ValuationMaintenanceRequest,
    assumption_changes,
    basis_point,
    eps_changes,
    figure_changes,
    fx_separable,
    restate,
    revenue_growth_changes,
    scenario_walk,
    source_conflicts,
)
from trading_max.research.valuation_preview import (
    AssumptionReference,
    ValuationPreviewRequest,
    locked_set,
)

from ..research_journal import SavedResearchModel
from .dependencies import app_service, latest_or_503
from .valuation_preview import family_valuation_preview

router = APIRouter(tags=["research"])


def _moment(value: Any) -> datetime | date | None:
    if isinstance(value, datetime | date):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value) if len(value) == 10 else datetime.fromisoformat(value)
    except ValueError:
        return None


def _saved_revenue_growth(saved: SavedResearchModel):
    """Revenue-growth consensus as recorded with the saved version, when it was."""
    points = []
    for ref in saved.preview.references:
        end = _moment(ref.period)
        if ref.source == "yahoo-finance-consensus" and type(end) is date:
            points.append((end, _consensus_value(ref), _moment(ref.as_of)))
    audit = saved.draft_audit
    for row in audit.draft.evidence.rows if audit else ():
        if (
            row.metric == Metric.CONSENSUS_REVENUE_GROWTH
            and row.state == "available"
            and row.period.end is not None
        ):
            points.append((row.period.end, row.value, row.published_at or row.observed_at))
    return points


def _consensus_value(ref: AssumptionReference) -> float:
    return ref.reference_value if ref.reference_value is not None else ref.value - ref.adjustment


def _current_revenue_growth(analyst: dict[str, Any] | None):
    analyst = analyst or {}
    points = []
    for row in analyst.get("revenueEstimate") or []:
        if not isinstance(row, dict) or (row.get("period") or row.get("index")) not in {
            "0y",
            "+1y",
        }:
            continue
        end, growth = _moment(row.get("endDate")), number(row.get("growth"))
        if type(end) is date and growth is not None:
            points.append((end, growth, _moment(row.get("asOf") or analyst.get("asOf"))))
    return points


@router.post("/v2/research/{ticker}/valuation-maintenance", response_model=ValuationMaintenance)
def valuation_maintenance(
    ticker: str, body: ValuationMaintenanceRequest, request: Request
) -> ValuationMaintenance:
    # Pure computation over the latest publication and one saved version. It does
    # not refresh providers, contact a model or save anything.
    manifest = latest_or_503(request)
    journal = app_service(request, "research_journal").load(ticker)
    saved = next((m for m in journal.models if m.id == body.model_id), None)
    if saved is None:
        raise HTTPException(status_code=404, detail="research-model-not-found")
    model = saved.preview
    if not model.scenarios:
        raise HTTPException(status_code=422, detail="no-valuation-range-to-save")
    current = family_valuation_preview(
        ticker,
        request,
        ValuationPreviewRequest(
            family=model.basis.family,
            formula_version=model.formula_version,
            horizon=body.horizon,
            scenarios=body.scenarios,
            data_version=body.data_version,
        ),
        manifest=manifest,
    )
    if current.basis.currency != model.basis.currency:
        raise HTTPException(status_code=422, detail="valuation-currency-changed")
    if not current.scenarios:
        raise HTTPException(status_code=422, detail="no-valuation-range-to-save")
    research = app_service(request, "research")
    lens = research.lens_snapshot(ticker, "valuation", manifest)
    facts = lens.financial_facts
    restated, restatements, check = restate(model.basis, facts)
    try:
        walk = scenario_walk(model, current.basis, body.scenarios, body.horizon, restated)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    listing = lens.context.quote.listing if lens.context else None
    archive = app_service(request, "estimate_history")
    eps = []
    if listing:
        symbol = ticker.upper()
        before = archive.valuation_window(symbol, listing, cutoff=saved.saved_at.astimezone(UTC))
        now = archive.valuation_window(symbol, listing, cutoff=manifest.created_at)
        eps = eps_changes(before[0] if before else None, now[0] if now else None)
    analyst = research.lens_snapshot(ticker, "analyst", manifest).analyst
    estimates = [
        *eps,
        *revenue_growth_changes(_saved_revenue_growth(saved), _current_revenue_growth(analyst)),
    ]
    locked = locked_set(body.locked_inputs)
    return ValuationMaintenance(
        model_id=saved.id,
        saved_at=saved.saved_at,
        family=model.basis.family,
        formula_version=model.formula_version,
        horizon=body.horizon,
        currency=model.basis.currency,
        saved=basis_point(model.basis),
        current=basis_point(current.basis),
        fx_separated=fx_separable(model.basis, current.basis),
        scenarios=walk,
        figures=figure_changes(model.basis, current.basis),
        restatement_check=check,
        restatements=restatements,
        conflicts=source_conflicts(facts, model.basis.family, current.basis.period_id),
        estimates=estimates,
        assumptions=assumption_changes(model, body.scenarios, locked),
        locked_inputs=locked,
        new_statements=model.basis.period_id != current.basis.period_id or check == "restated",
        new_estimates=bool(estimates),
    )
