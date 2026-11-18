"""Draft valuation assumptions on demand against one local publication."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic_ai.exceptions import RunCancelled, RunTimedOut
from starlette.responses import StreamingResponse
from trading_max.research.fundamentals import sector_profile_by_label
from trading_max.research.statement_valuation import scenario_template_inputs
from trading_max.research.valuation_evidence import (
    EvidenceBinding,
    EvidenceLimitError,
    Metric,
    ValuationEvidenceTools,
)
from trading_max.research.valuation_preview import ValuationPreviewRequest, preview

from ..agent.runtime import error_code
from ..agent.service import AssistantUnavailable
from ..agent.valuation import DraftAgent, annual_revenue_growth
from ..assistant_settings import ASSISTANT_CONSENT_REVISION
from ..valuation_drafts import (
    DRAFT_BLOCK_REASONS,
    DeskReading,
    DraftEvent,
    DraftInput,
    DraftRecord,
    DraftResult,
    TemplateInputs,
    ValuationDraftStore,
    check_draft_preview,
)
from ..valuation_evidence import freeze_valuation_evidence
from .dependencies import app_service, latest_or_503, require_write_auth
from .valuation_preview import family_valuation_preview

router = APIRouter(tags=["research"])
TIMEOUT = 90


def _prepare(request, ticker, body, share_saved, progress):
    manifest = latest_or_503(request)
    journal = app_service(request, "research_journal")
    with journal.lock:
        view = family_valuation_preview(
            ticker, request, requested_family=body.requested_family, manifest=manifest
        )
        models = journal.load(ticker).models
    check_draft_preview(view)
    if view.id != body.preview_id:
        raise ValueError("valuation-draft-review-required")
    # Unsaved edits participate in the local eligibility check only.
    check_draft_preview(
        preview(
            view.basis,
            ValuationPreviewRequest(
                family=view.basis.family,
                horizon=body.horizon,
                scenarios=body.scenarios,
                formula_version=view.formula_version,
            ),
        )
    )
    lens = app_service(request, "research").lens_snapshot(ticker, "valuation", manifest)
    listing = lens.context.quote.listing
    if not listing:
        raise ValueError("valuation-evidence-unavailable")
    binding = EvidenceBinding(
        workspace_id="valuation-workspace",
        ticker=ticker.upper(),
        listing=listing,
        cutoff=manifest.created_at,
        snapshot_run_id=manifest.run_id,
        permitted_fields=frozenset(Metric),
    )
    frozen = freeze_valuation_evidence(
        binding,
        snapshots=app_service(request, "store"),
        estimate_reader=app_service(request, "estimate_history").valuation_window,
        selected_family=view.basis.family,
    )
    frozen = frozen.model_copy(update={"formula_version": view.formula_version})
    public = ValuationEvidenceTools(binding, frozen).get_valuation_basis().basis
    if public is None or (public.family != "residual-income" and public.revenue == 0):
        raise ValueError("valuation-evidence-unavailable")
    # The desk can use its broker mark; the company, statement, FX and share
    # units still have to match the public evaluator exactly.
    for field in (
        "family",
        "period_id",
        "currency",
        "reporting_currency",
        "fx_rate",
        "shares",
        "ordinary_per_receipt",
        "revenue",
        "book_per_share",
        "common_earnings",
    ):
        if getattr(public, field) != getattr(view.basis, field):
            raise ValueError("valuation-evidence-unavailable")
    profile = sector_profile_by_label(lens.valuation.assumptions.get("profile"))
    cost = next(
        (
            row.value
            for row in frozen.rows
            if row.metric == Metric.COST_OF_EQUITY
            and row.value is not None
            and 0.01 <= row.value <= 0.6
        ),
        profile.discount,
    )
    growth = annual_revenue_growth(frozen)
    templates = scenario_template_inputs(public, profile, cost, growth)
    prior = next((m for m in models if m.preview.basis.family == frozen.family), None)
    saved = (
        {k: v.inputs for k, v in prior.preview.scenarios.items()} if share_saved and prior else None
    )
    if share_saved and saved is None and view.default_source == "configured-scenarios":
        saved = {k: v.inputs for k, v in view.scenarios.items()}
    template_inputs = TemplateInputs(
        profile=profile.label,
        growth_cap=profile.growth_cap,
        margin_cap=profile.margin_cap,
        profile_discount=profile.discount,
        exit_multiple=profile.exit_multiple,
        share_cagr=profile.share_cagr,
        effective_discount_rate=cost,
        annual_revenue_growth=growth,
        basis=public,
    )
    runner = DraftAgent(
        frozen,
        templates,
        template_inputs,
        saved,
        prior.id if prior and share_saved else None,
        body.horizon,
        progress,
        view.family_selection,
    )
    parent = models[0].id if models else None
    return runner, view, parent


class DraftStream(StreamingResponse):
    media_type = "application/x-ndjson"


@router.post(
    "/v1/research/{ticker}/valuation-draft",
    dependencies=[Depends(require_write_auth)],
    response_class=DraftStream,
    responses={200: {"model": DraftEvent, "description": "One draft event per line."}},
)
async def valuation_draft(ticker: str, body: DraftInput, request: Request):
    drafts: ValuationDraftStore = app_service(request, "valuation_drafts")
    preferences = app_service(request, "settings_repository")
    prefs = preferences.get_assistant_preferences()
    if (
        not prefs.enabled
        or prefs.accepted_consent_revision != ASSISTANT_CONSENT_REVISION
        or ASSISTANT_CONSENT_REVISION < 2
    ):
        raise HTTPException(status_code=403, detail="assistant_consent_required")

    revision = prefs.revision

    def check_preferences():
        if preferences.get_assistant_preferences().revision != revision:
            raise ValueError("valuation-draft-settings-changed")

    async def stream():
        def line(phase, **data):
            return (
                DraftEvent(phase=phase, **data).model_dump_json(exclude_none=phase != "complete")
                + "\n"
            )

        if not drafts.running.acquire(blocking=False):
            yield line("error", code="assistant_busy")
            return
        events: asyncio.Queue[str] = asyncio.Queue()

        async def generate():
            async with asyncio.timeout(TIMEOUT):
                # A privacy or route change invalidates the run before another tool result leaves.
                def progress(phase):
                    check_preferences()
                    events.put_nowait(phase)

                check_preferences()
                runner, view, parent = await asyncio.to_thread(
                    _prepare,
                    request,
                    ticker,
                    body,
                    prefs.share_valuation_assumptions,
                    progress,
                )

                check_preferences()
                bound = await app_service(request, "assistant").bind_model()
                check_preferences()
                async with bound.model:
                    selection = await runner.run(
                        bound.model, bound.settings, bound.cancellation_token
                    )
                check_preferences()
                journal = app_service(request, "research_journal")

                def current():
                    with journal.lock:
                        manifest = latest_or_503(request)
                        if manifest.run_id != runner.frozen.binding.snapshot_run_id:
                            return False
                        latest = family_valuation_preview(
                            ticker,
                            request,
                            requested_family=body.requested_family,
                            manifest=manifest,
                        )
                        parents = journal.load(ticker).models
                        return (
                            latest.id == view.id and (parents[0].id if parents else None) == parent
                        )

                if not await asyncio.to_thread(current):
                    raise ValueError("valuation-draft-review-required")
                proposed = dict(body.scenarios)
                for proposal in selection.proposals:
                    scenario = proposed[proposal.scenario]
                    proposed[proposal.scenario] = scenario.model_copy(
                        update={proposal.field: proposal.value}
                    )
                projected = preview(
                    view.basis,
                    ValuationPreviewRequest(
                        family=view.basis.family,
                        horizon=body.horizon,
                        scenarios=proposed,
                        formula_version=view.formula_version,
                    ),
                )
                check_draft_preview(projected)
                result = DraftResult(
                    **selection.model_dump(),
                    desk_readings={
                        key: DeskReading(value=row.value, upside=row.upside)
                        for key, row in projected.scenarios.items()
                    },
                )
                return DraftRecord(
                    result=result,
                    evidence=runner.frozen,
                    public_evaluation_id=runner.evaluation_id,
                    formula_version=view.formula_version,
                    horizon=body.horizon,
                    review_basis=view.basis,
                    parent_model_id=parent,
                    original=body.scenarios,
                )

        task = asyncio.create_task(generate())
        try:
            phase = "preparing"
            yield line(phase)
            while not task.done():
                if await request.is_disconnected():
                    return
                with suppress(TimeoutError):
                    phase = await asyncio.wait_for(events.get(), timeout=0.5)
                if not task.done():
                    yield line(phase)
            record = task.result()
            check_preferences()
            drafts.put(record)
            try:
                check_preferences()
            except ValueError:
                drafts.discard(record.result.id)
                raise
            yield line("complete", result=record.result)
        except Exception as exc:
            code = _failure(exc)
            yield line("error", code=code)
        finally:
            task.cancel()
            with anyio.CancelScope(shield=True), suppress(asyncio.CancelledError, Exception):
                await task
            drafts.running.release()

    return DraftStream(
        stream(),
        headers={"Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no"},
    )


def _failure(exc: Any) -> str:
    if isinstance(exc, RunCancelled):
        return "valuation-draft-settings-changed"
    if isinstance(exc, TimeoutError | RunTimedOut):
        return "assistant_timeout"
    if isinstance(exc, AssistantUnavailable):
        return exc.code
    if isinstance(exc, EvidenceLimitError):
        return "assistant_limit_reached"
    if isinstance(exc, HTTPException) and exc.status_code in {422, 503}:
        if isinstance(exc.detail, str) and exc.detail in DRAFT_BLOCK_REASONS:
            return exc.detail
        return "valuation-evidence-unavailable"
    if isinstance(exc, ValueError) and str(exc) in DRAFT_BLOCK_REASONS | {
        "valuation-draft-review-required",
        "valuation-evidence-unavailable",
        "valuation-draft-settings-changed",
    }:
        return str(exc)
    return error_code(exc)
