"""Name the evidence that has arrived since a valuation version was saved.

A notice compares the newest saved version of a security with the current
publication and the local estimate record. It is local and deterministic: it
never drafts, contacts a model or saves a version. Each piece of evidence has a
stable key, so the same report or estimate move is announced once.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from trading_max.domain import DomainModel

from .facts import fingerprint
from .valuation_maintenance import EstimateChange, Restating

# Consensus moves count in whole steps from the value recorded at the save:
# fiscal-year EPS by 5% of that value, revenue growth by two percentage points.
EPS_STEP = 0.05
GROWTH_STEP = 0.02

EvidenceKind = Literal["statements", "restatement", "estimate"]


class EvidenceNoticeItem(DomainModel):
    key: str
    kind: EvidenceKind
    # The newer statement period, or the saved period that was restated.
    period_id: str | None = None
    metric: Literal["consensusEps", "consensusRevenueGrowth"] | None = None
    period_end: date | None = None
    currency: str | None = None
    saved: float | None = None
    current: float | None = None
    as_of: datetime | date | None = None


def estimate_step(change: EstimateChange) -> int:
    """Whole steps a consensus has moved from its saved value, signed; 0 within one step."""
    if change.metric == "consensusEps":
        if change.saved == 0:
            return 0 if change.current == 0 else (1 if change.current > 0 else -1)
        moved = (change.current - change.saved) / abs(change.saved) / EPS_STEP
    else:
        moved = (change.current - change.saved) / GROWTH_STEP
    # Rounded first, so 13% → 15% is one step despite binary fractions.
    return int(round(moved, 9))


def period_end(period_id: str | None) -> date | None:
    """The end of a statement period from its identity, such as "ttm:2026-03-31"."""
    kind, _, end = (period_id or "").partition(":")
    try:
        return date.fromisoformat(end) if kind and end else None
    except ValueError:
        return None


def statement_items(
    saved_period: str | None, current_period: str | None, restating: Restating
) -> list[EvidenceNoticeItem]:
    """Statements that end after the saved period, and a restatement of the saved period.

    A basis that ends no later, such as an older period after an incomplete
    publication, or one whose end cannot be read, is not a new report.
    """
    items = []
    saved_end, current_end = period_end(saved_period), period_end(current_period)
    if current_period and saved_end and current_end and current_end > saved_end:
        items.append(
            EvidenceNoticeItem(
                key="statements:" + current_period, kind="statements", period_id=current_period
            )
        )
    if restating.check == "restated" and saved_period:
        figures = [[change.metric, change.current] for change in restating.changes]
        items.append(
            EvidenceNoticeItem(
                key="restated:" + fingerprint([saved_period, figures]),
                kind="restatement",
                period_id=saved_period,
            )
        )
    return items


def estimate_items(changes: list[EstimateChange]) -> list[EvidenceNoticeItem]:
    """Consensus moves of at least one step; a further step is new evidence again."""
    items = []
    for change in changes:
        step = estimate_step(change)
        if not step:
            continue
        end = change.period_end.isoformat()
        items.append(
            EvidenceNoticeItem(
                key=f"{change.metric}:{end}:{change.currency or ''}:{step}",
                kind="estimate",
                metric=change.metric,
                period_end=change.period_end,
                currency=change.currency,
                saved=change.saved,
                current=change.current,
                as_of=change.current_as_of,
            )
        )
    return items
