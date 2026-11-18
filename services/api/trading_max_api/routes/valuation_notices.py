"""Notices of new evidence for saved valuation versions, and the version Review reads.

Nothing here drafts, contacts a model or saves a valuation version. Recording
which evidence the reader has opened is the only write.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from trading_max.research.evidence_notice import EvidenceNoticeItem, estimate_items, statement_items
from trading_max.research.valuation_maintenance import restate
from trading_max.research.valuation_preview import ValuationPreviewRequest

from ..evidence_notices import (
    EvidenceNotice,
    EvidenceNotices,
    EvidenceSeen,
    ModelVersionAt,
    SavedModelSummary,
)
from ..models import SnapshotManifest
from ..research_journal import SavedResearchModel
from .dependencies import app_service, require_write_auth
from .valuation_maintenance import saved_estimate_changes
from .valuation_preview import family_valuation_preview

router = APIRouter(tags=["research"])
LOGGER = logging.getLogger("trading_max.research.evidence_notices")


def _evidence(
    ticker: str, request: Request, manifest: SnapshotManifest, saved: SavedResearchModel
) -> list[EvidenceNoticeItem]:
    """What See new evidence would show for this version, whatever the proposal."""
    model = saved.preview
    try:
        current = family_valuation_preview(
            ticker,
            request,
            ValuationPreviewRequest(
                family=model.basis.family,
                formula_version=model.formula_version,
                horizon=model.horizon,
                scenarios={key: scenario.inputs for key, scenario in model.scenarios.items()},
            ),
            manifest=manifest,
        )
    except HTTPException:
        return []  # the comparison cannot run on this publication, so there is nothing to open
    if current.basis.currency != model.basis.currency:
        return []
    lens = app_service(request, "research").lens_snapshot(ticker, "valuation", manifest)
    restating = restate(model.basis, lens.financial_facts)
    listing = lens.context.quote.listing if lens.context else None
    return [
        *statement_items(model.basis.period_id, current.basis.period_id, restating),
        *estimate_items(saved_estimate_changes(ticker, request, manifest, saved, listing)),
    ]


@router.get("/v1/valuation/evidence-notices", response_model=EvidenceNotices)
def evidence_notices(request: Request) -> EvidenceNotices:
    preferences = app_service(request, "settings_repository").get_automation_preferences()
    # Off by default: with the switch off nothing is compared or read.
    if not preferences.evidence_notices_enabled:
        return EvidenceNotices(enabled=False)
    manifest = app_service(request, "store").latest_manifest()
    if manifest is None:
        return EvidenceNotices(enabled=True)
    journal = app_service(request, "research_journal")
    store = app_service(request, "evidence_notices")
    seen = store.seen()
    notices = []
    for ticker, saved in journal.latest_models():
        try:
            items = store.evidence.get_or_compute(
                (ticker, manifest.run_id, saved.id),
                lambda ticker=ticker, saved=saved: _evidence(ticker, request, manifest, saved),
            )
        except Exception as exc:  # one security's failure leaves the others' notices
            LOGGER.warning(
                "Could not compare a saved valuation with new evidence",
                extra={"ticker": ticker, "error_type": type(exc).__name__},
            )
            continue
        opened = set(seen.get(ticker, {}).get(saved.id, []))
        unseen = [item for item in items if item.key not in opened]
        if unseen:
            notices.append(
                EvidenceNotice(
                    ticker=ticker, model_id=saved.id, saved_at=saved.saved_at, items=unseen
                )
            )
    notices.sort(key=lambda notice: notice.ticker)
    return EvidenceNotices(enabled=True, run_id=manifest.run_id, notices=notices)


@router.post(
    "/v1/valuation/evidence-notices/{ticker}/seen",
    response_model=EvidenceNotices,
    dependencies=[Depends(require_write_auth)],
)
def evidence_notices_seen(ticker: str, body: EvidenceSeen, request: Request) -> EvidenceNotices:
    saved = app_service(request, "research_journal").latest_model(ticker)
    if saved is None or saved.id != body.model_id:
        raise HTTPException(status_code=409, detail="research-model-not-latest")
    app_service(request, "evidence_notices").mark_seen(ticker, body.model_id, body.keys)
    return evidence_notices(request)


@router.get("/v1/research/{ticker}/models/as-of", response_model=ModelVersionAt)
def research_model_as_of(
    ticker: str, request: Request, day: Annotated[date, Query()]
) -> ModelVersionAt:
    """The newest version saved by the end of a decision's day, which is a UTC ledger day."""
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=UTC)
    saved = max(
        (
            m
            for m in app_service(request, "research_journal").load(ticker).models
            if m.preview.scenarios and m.saved_at < end
        ),
        key=lambda m: m.saved_at,
        default=None,
    )
    if saved is None:
        return ModelVersionAt(day=day)
    model = saved.preview
    return ModelVersionAt(
        day=day,
        model=SavedModelSummary(
            id=saved.id,
            saved_at=saved.saved_at,
            family=model.basis.family,
            horizon=model.horizon,
            currency=model.basis.currency,
        ),
    )
