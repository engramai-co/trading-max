"""Local notices of new evidence for saved valuation versions.

Notices are derived on request from the newest saved version of each listed
security and the current publication. Only the evidence a reader has opened
is stored, so the same report or estimate move is announced once.
"""

from __future__ import annotations

import json
import threading
from datetime import date, datetime
from pathlib import Path

from pydantic import Field
from trading_max.domain import DomainModel
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.evidence_notice import EvidenceNoticeItem
from trading_max.research.valuation_basis import Family

from .valuation_assumptions import _atomic_write


class EvidenceNotice(DomainModel):
    ticker: str
    model_id: str
    saved_at: datetime
    items: list[EvidenceNoticeItem]


class EvidenceNotices(DomainModel):
    enabled: bool
    run_id: str | None = None
    notices: list[EvidenceNotice] = Field(default_factory=list)


class EvidenceSeen(DomainModel):
    model_id: str = Field(min_length=1, max_length=64)
    keys: list[str] = Field(min_length=1, max_length=64)


class SavedModelSummary(DomainModel):
    id: str
    saved_at: datetime
    family: Family
    horizon: int
    currency: str


class ModelVersionAt(DomainModel):
    """The newest version saved by the end of a day, as Review reads a decision."""

    day: date
    model: SavedModelSummary | None = None


class EvidenceNoticeStore:
    """Evidence keys a reader has opened, kept for the newest version of each security."""

    def __init__(self, state_root: Path) -> None:
        self.path = state_root / "evidence-notices.json"
        self.lock = threading.RLock()
        # Evidence depends only on the publication and the saved version.
        self.evidence: SingleFlightCache[tuple[str, str, str], list[EvidenceNoticeItem]] = (
            SingleFlightCache(capacity=512)
        )

    def seen(self) -> dict[str, dict[str, list[str]]]:
        with self.lock:
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, ValueError):
                return {}
        seen = payload.get("seen") if isinstance(payload, dict) else None
        return seen if isinstance(seen, dict) else {}

    def mark_seen(self, ticker: str, model_id: str, keys: list[str]) -> None:
        with self.lock:
            seen = self.seen()
            kept = seen.get(ticker.upper(), {}).get(model_id, [])
            # An older version's keys go: only the newest version carries a notice.
            seen[ticker.upper()] = {model_id: sorted({*kept, *keys})}
            _atomic_write(self.path, {"schemaVersion": 1, "seen": seen})
