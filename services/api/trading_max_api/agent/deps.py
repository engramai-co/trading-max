"""Server-selected, snapshot-bound dependencies for an assistant run."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel
from pydantic_ai import ModelRetry

from ..dashboard_models import ResearchPriceSeries
from ..models import SnapshotManifest
from ..research_listing import PinnedListing
from .page_sources import PageSources

ListingReader = Callable[[str, SnapshotManifest], PinnedListing]

AccountScope = Literal["invest", "isa", "broker_total", "household", "cfd"]
ALL_ACCOUNT_SCOPES: frozenset[AccountScope] = frozenset(
    ("invest", "isa", "broker_total", "household", "cfd")
)
DEFAULT_TIMEZONE = ZoneInfo("Europe/London")


# A missing key leaves an argument to the caller. A bound null is an explicit selection.
type ToolBindings = dict[str, dict[str, str | int | bool | None]]


def bind_arguments(
    supplied: dict[str, Any], bound: dict[str, Any], schema: type[BaseModel] | None = None
) -> dict[str, Any]:
    supplied = supplied.copy()
    for name, field in schema.model_fields.items() if schema else ():
        wire = field.validation_alias
        if isinstance(wire, str) and wire != name and name in supplied:
            value = supplied.pop(name)
            if wire in supplied and (
                type(supplied[wire]) is not type(value) or supplied[wire] != value
            ):
                raise ModelRetry("Conflicting tool arguments: " + wire)
            supplied[wire] = value
    for key, selected in bound.items():
        if key in supplied and (
            type(supplied[key]) is not type(selected) or supplied[key] != selected
        ):
            raise ModelRetry("Tool argument conflicts with the selected object: " + key)
    return supplied | bound


class AssistantSnapshotReader(Protocol):
    """Only the immutable read surface is needed by the assistant."""

    def load_manifest(self, run_id: str, *, require_retained: bool = False) -> SnapshotManifest: ...
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
    pin_listing: ListingReader | None = None
    listing_error: str | None = None
    role_bindings: ToolBindings | None = None

    def bound_evidence(self, tool: str) -> dict[str, str | None]:
        """Use string identifiers in links, retaining null to clear an unselected filter."""
        if self.role_bindings is None:
            return {}
        arguments = {"snapshotId": self.snapshot_id}
        for name, value in self.role_bindings[tool].items():
            if isinstance(value, bool):
                arguments[name] = "true" if value else "false"
            else:
                arguments[name] = str(value) if value is not None else None
        return arguments

    @property
    def snapshot_id(self) -> str | None:
        return self.manifest.run_id if self.manifest is not None else None


@dataclass(frozen=True, slots=True)
class AssistantDepsFactory:
    """Create one dependency bundle per run in the authenticated workspace."""

    store: AssistantSnapshotSource
    allowed_scopes: frozenset[AccountScope] = ALL_ACCOUNT_SCOPES

    bind_price_series: Callable[[], tuple[PublishedPriceReader, ListingReader]] | None = None
    bind_page_sources: Callable[[], PageSources] | None = None

    def for_run(self, page_hint: str | None = None, timezone: str | None = None) -> AssistantDeps:
        zone = DEFAULT_TIMEZONE
        if timezone and len(timezone) <= 128:
            with suppress(ValueError, ZoneInfoNotFoundError):
                zone = ZoneInfo(timezone)
        manifest = self.store.latest_manifest()
        price_series = None
        pin_listing = None
        listing_error = None
        if self.bind_price_series is not None:
            # An unreadable watchlist prevents safe chart routing for this run.
            # The other tools read their own immutable snapshot artifacts.
            try:
                price_series, pin_listing = self.bind_price_series()
            except (OSError, ValueError):
                listing_error = "watchlist_routing_unavailable"
        return AssistantDeps(
            page_sources=self.bind_page_sources()
            if self.bind_page_sources
            and page_hint in {"holdings", "analytics", "sectors", "health"}
            else None,
            price_series=price_series,
            pin_listing=pin_listing,
            listing_error=listing_error,
            manifest=manifest.model_copy(deep=True) if manifest is not None else None,
            allowed_scopes=frozenset(self.allowed_scopes),
            store=self.store,
            timezone=zone,
            page_hint=page_hint[:128] if page_hint else None,
            captured_at=datetime.now(UTC),
        )
