"""Typed taxonomy artifact stage.

The stage only normalizes persisted watchlist taxonomy state. LLM decisions
remain additive and are applied through trading_max.research.taxonomy; this
boundary never invents a category when the source is absent.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from trading_max.domain import ArtifactQuality, InstrumentId
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.research.taxonomy import (
    GrowingTaxonomy,
    TaxonomyAssignmentRecord,
    TaxonomyCatalog,
    TaxonomyTheme,
)

from .errors import StageExecutionError
from .stages import StageContext, StageResult


class TaxonomyCatalogProvider(Protocol):
    def load(self) -> tuple[TaxonomyCatalog, list[str]]:
        """Return a normalized catalog and source-quality warnings."""


def _text(value: Any) -> str:
    return str(value or "").strip()


class RawTaxonomyCatalogProvider:
    """Read an explicit catalog or normalize the current watchlist state."""

    def __init__(self, state_root: Path) -> None:
        self.state_root = state_root.expanduser().resolve()

    def load(self) -> tuple[TaxonomyCatalog, list[str]]:
        explicit = self.state_root / "taxonomy.json"
        if explicit.is_file():
            payload = json.loads(explicit.read_text(encoding="utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("taxonomy.json must contain an object")
            return GrowingTaxonomy(TaxonomyCatalog.model_validate(payload)).catalog, []

        watchlist = self.state_root / "watchlist.json"
        if not watchlist.is_file():
            raise FileNotFoundError(f"taxonomy source is missing: {explicit} and {watchlist}")
        payload = json.loads(watchlist.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError("watchlist.json must contain an object")
        return self._from_watchlist(payload)

    @staticmethod
    def _from_watchlist(
        payload: Mapping[str, Any],
    ) -> tuple[TaxonomyCatalog, list[str]]:
        themes: list[TaxonomyTheme] = []
        for raw in payload.get("categories", []):
            if not isinstance(raw, Mapping):
                continue
            theme_id = _text(raw.get("id"))
            label_en = _text(raw.get("labelEn") or raw.get("label_en"))
            label_zh = _text(raw.get("labelZh") or raw.get("label_zh"))
            if not theme_id or not label_en or not label_zh:
                continue
            themes.append(
                TaxonomyTheme(
                    id=theme_id,
                    label_zh=label_zh,
                    label_en=label_en,
                    description_zh=_text(raw.get("descriptionZh") or raw.get("description_zh")),
                    description_en=_text(raw.get("descriptionEn") or raw.get("description_en")),
                    order=int(raw.get("order") or len(themes) + 1),
                )
            )
        taxonomy = GrowingTaxonomy(TaxonomyCatalog(themes=themes))
        assignments: list[TaxonomyAssignmentRecord] = []
        theme_ids = {theme.id for theme in taxonomy.catalog.themes}
        for raw in payload.get("items", []):
            if not isinstance(raw, Mapping):
                continue
            ticker = _text(raw.get("ticker")).upper()
            theme_id = _text(
                raw.get("researchThemeId")
                or raw.get("research_theme_id")
                or raw.get("categoryId")
                or raw.get("category_id")
            )
            if not ticker or theme_id not in theme_ids:
                continue
            theme = next(theme for theme in taxonomy.catalog.themes if theme.id == theme_id)
            assignments.append(
                TaxonomyAssignmentRecord(
                    instrument=InstrumentId(
                        ticker=ticker,
                        exchange=_text(raw.get("exchange")),
                        isin=_text(raw.get("isin")),
                        bloomberg_ticker=_text(
                            raw.get("bloombergTicker") or raw.get("bloomberg_ticker")
                        ),
                        figi=_text(raw.get("figi")),
                    ),
                    taxonomy_id=theme.id,
                    label=theme.label_en,
                    method="fallback",
                    rationale=("normalized from watchlist state without assignment provenance"),
                )
            )
        taxonomy.catalog.assignments = assignments
        return taxonomy.catalog, [
            "taxonomy provenance is not explicit in watchlist.json; assignments are marked fallback"
        ]


class TaxonomyArtifactStage:
    """Publish the current watchlist taxonomy as an immutable research artifact."""

    name = "research.taxonomy"
    version = "taxonomy-v2"
    required_for = frozenset({"all", "research"})
    dependencies: tuple[str, ...] = ()

    def __init__(
        self,
        artifacts: ContentAddressedArtifactStore,
        provider: TaxonomyCatalogProvider,
    ) -> None:
        self.artifacts = artifacts
        self.provider = provider

    def run(self, context: StageContext) -> StageResult:
        try:
            catalog, warnings = self.provider.load()
        except FileNotFoundError as exc:
            raise StageExecutionError(
                "research.taxonomy_source_missing",
                str(exc),
            ) from exc
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise StageExecutionError(
                "research.taxonomy_source_invalid",
                str(exc),
            ) from exc
        artifact = self.artifacts.put_json(
            key="research/taxonomy.json",
            payload=catalog.model_dump(mode="json", by_alias=False),
            kind="taxonomy",
            producer_version=self.version,
            quality=ArtifactQuality(
                status="warning" if warnings else "verified",
                coverage=f"{len(catalog.assignments)} assignments",
                warnings=warnings,
            ),
        )
        return StageResult(artifacts=(artifact.ref,), warnings=tuple(warnings))


__all__ = [
    "RawTaxonomyCatalogProvider",
    "TaxonomyArtifactStage",
    "TaxonomyCatalogProvider",
]
