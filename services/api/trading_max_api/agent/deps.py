"""Server-selected, snapshot-bound dependencies for an assistant run."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..dashboard_models import ResearchPriceSeries
from ..models import SnapshotManifest
from .page_sources import PageSources

AccountScope = Literal["invest", "isa", "broker_total", "household", "cfd"]
ALL_ACCOUNT_SCOPES: frozenset[AccountScope] = frozenset(
    ("invest", "isa", "broker_total", "household", "cfd")
)
DEFAULT_TIMEZONE = ZoneInfo("Europe/London")


class AssistantSnapshotReader(Protocol):
    """Only the immutable read surface is needed by the assistant."""

    def load_manifest(self, run_id: str) -> SnapshotManifest: ...
    def read_json(self, run_id: str, key: str) -> dict: ...
    def read_text(self, run_id: str, key: str) -> str: ...


class AssistantSnapshotSource(AssistantSnapshotReader, Protocol):
    def latest_manifest(self) -> SnapshotManifest | None: ...


class PublishedPriceReader(Protocol):
    def __call__(
        self, ticker: str, manifest: SnapshotManifest, *, limit: int
    ) -> ResearchPriceSeries: ...


@dataclass(frozen=True, slots=True)
class AssistantDeps:
    manifest: SnapshotManifest | None
    allowed_scopes: frozenset[AccountScope]
    store: AssistantSnapshotReader
    timezone: ZoneInfo = DEFAULT_TIMEZONE
    page_hint: str | None = None
    captured_at: datetime | None = None
    price_series: PublishedPriceReader | None = None

    page_sources: PageSources | None = None

    @property
    def snapshot_id(self) -> str | None:
        return self.manifest.run_id if self.manifest is not None else None


@dataclass(frozen=True, slots=True)
class AssistantDepsFactory:
    """Create one dependency bundle per run in the authenticated workspace."""

    store: AssistantSnapshotSource
    allowed_scopes: frozenset[AccountScope] = ALL_ACCOUNT_SCOPES

    bind_price_series: Callable[[], PublishedPriceReader] | None = None

    def for_run(self, page_hint: str | None = None, timezone: str | None = None) -> AssistantDeps:
        zone = DEFAULT_TIMEZONE
        if timezone and len(timezone) <= 128:
            with suppress(ValueError, ZoneInfoNotFoundError):
                zone = ZoneInfo(timezone)
        manifest = self.store.latest_manifest()
        return AssistantDeps(
            price_series=self.bind_price_series() if self.bind_price_series else None,
            manifest=manifest.model_copy(deep=True) if manifest is not None else None,
            allowed_scopes=frozenset(self.allowed_scopes),
            store=self.store,
            timezone=zone,
            page_hint=page_hint[:128] if page_hint else None,
            captured_at=datetime.now(UTC),
        )
