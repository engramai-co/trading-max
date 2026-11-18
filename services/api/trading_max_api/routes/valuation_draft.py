"""Draft valuation assumptions on demand against one local publication."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic_ai.exceptions import RunTimedOut
from starlette.responses import StreamingResponse
from trading_max.research.fundamentals import _sector_profile
from trading_max.research.statement_valuation import scenario_template_inputs
from trading_max.research.valuation_evidence import (
    EvidenceBinding,
    EvidenceLimitError,
    Metric,
    ValuationEvidenceTools,
)

from ..agent.runtime import error_code
from ..agent.service import AssistantUnavailable
from ..agent.valuation import DraftAgent, annual_revenue_growth
from ..assistant_settings import ASSISTANT_CONSENT_REVISION
from ..valuation_drafts import (
    DraftEvent,
    DraftInput,
    DraftRecord,
    ValuationDraftStore,
    basis_digest,
)
from ..valuation_evidence import freeze_valuation_evidence
from .dependencies import app_service, latest_or_503, require_write_auth
from .research import _valuation_preview

router = APIRouter(tags=["research"])
TIMEOUT = 90


def _prepare(request, ticker, body, share_saved, progress):
    manifest = latest_or_503(request)
    journal = app_service(request, "research_journal")
    with journal.lock:
        view = _valuation_preview(
            ticker, request, requested_family=body.requested_family, manifest=manifest
        )
        models = journal.load(ticker).models
    if not view.scenarios or view.id != body.preview_id:
        raise ValueError("valuation-draft-review-required")
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
    if public is None or not public.revenue:
        raise ValueError("valuation-evidence-unavailable")
    profile, _ = _sector_profile(str(lens.valuation.assumptions.get("profile") or ""), "")
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
    runner = DraftAgent(frozen, templates, saved, body.horizon, progress)
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

    def check_preferences():
        if preferences.get_assistant_preferences().revision != prefs.revision:
            raise ValueError("valuation-draft-settings-changed")

    async def stream():
        def line(phase, **data):
            return DraftEvent(phase=phase, **data).model_dump_json(exclude_none=True) + "\n"

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
                    result = await runner.run(bound.model, bound.settings)
                check_preferences()
                journal = app_service(request, "research_journal")

                def current():
                    with journal.lock:
                        latest = _valuation_preview(
                            ticker, request, requested_family=body.requested_family
                        )
                        parents = journal.load(ticker).models
                        return (
                            latest.id == view.id and (parents[0].id if parents else None) == parent
                        )

                if not await asyncio.to_thread(current):
                    raise ValueError("valuation-draft-review-required")
                drafts.put(
                    DraftRecord(
                        result=result,
                        evidence=runner.frozen,
                        public_evaluation_id=runner.evaluation_id,
                        formula_version=view.formula_version,
                        horizon=body.horizon,
                        basis_digest=basis_digest(view.basis),
                        parent_model_id=parent,
                        original=body.scenarios,
                    )
                )
                return result

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
            yield line("complete", result=task.result())
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
    if isinstance(exc, TimeoutError | RunTimedOut):
        return "assistant_timeout"
    if isinstance(exc, AssistantUnavailable):
        return exc.code
    if isinstance(exc, EvidenceLimitError):
        return "assistant_limit_reached"
    if isinstance(exc, HTTPException) and exc.status_code in {422, 503}:
        return "valuation-evidence-unavailable"
    if isinstance(exc, ValueError) and str(exc) in {
        "valuation-draft-review-required",
        "valuation-evidence-unavailable",
        "valuation-draft-settings-changed",
    }:
        return str(exc)
    return error_code(exc)
