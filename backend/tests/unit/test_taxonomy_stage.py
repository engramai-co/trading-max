from __future__ import annotations

import json
from pathlib import Path

from trading_max.application import (
    RawTaxonomyCatalogProvider,
    StageContext,
    TaxonomyArtifactStage,
)
from trading_max.infrastructure import ContentAddressedArtifactStore


def test_taxonomy_provider_normalizes_watchlist_state(tmp_path: Path) -> None:
    (tmp_path / "watchlist.json").write_text(
        json.dumps(
            {
                "categories": [
                    {
                        "id": "ai-infrastructure",
                        "labelZh": "AI 基础设施",
                        "labelEn": "AI infrastructure",
                        "descriptionZh": "计算基础设施",
                        "descriptionEn": "Compute infrastructure",
                        "order": 1,
                    }
                ],
                "items": [
                    {
                        "ticker": "NVDA",
                        "name": "NVIDIA",
                        "exchange": "NASDAQ",
                        "researchThemeId": "ai-infrastructure",
                        "figi": "BBG000C5HS04",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    catalog, warnings = RawTaxonomyCatalogProvider(tmp_path).load()

    assert {theme.id for theme in catalog.themes} == {"ai-infrastructure"}
    assert catalog.assignments[0].instrument.ticker == "NVDA"
    assert catalog.assignments[0].method == "fallback"
    assert warnings


def test_taxonomy_stage_publishes_versioned_artifact(tmp_path: Path) -> None:
    (tmp_path / "watchlist.json").write_text(
        json.dumps(
            {
                "categories": [],
                "items": [],
            }
        ),
        encoding="utf-8",
    )
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    stage = TaxonomyArtifactStage(
        artifacts,
        RawTaxonomyCatalogProvider(tmp_path),
    )

    result = stage.run(
        StageContext(job_id="taxonomy-test", scope="research"),
    )

    assert len(result.artifacts) == 1
    stored = artifacts.get_json(result.artifacts[0].artifact_id)
    assert stored.ref.key == "research/taxonomy.json"
    assert stored.ref.quality.status == "warning"
    assert stored.payload["schema_version"] == 2
