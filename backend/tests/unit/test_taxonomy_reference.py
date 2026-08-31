from __future__ import annotations

import json
from pathlib import Path

import pytest
from trading_max.reference.taxonomy import (
    classification_for_profile,
    taxonomy_reference,
)


def test_taxonomy_reference_is_versioned_data_not_a_ticker_universe() -> None:
    reference = taxonomy_reference()

    assert reference.taxonomy_version == "2026"
    assert reference.crosswalk_version == "2026.08.2"
    assert "household-personal-products" in reference.profile_crosswalk
    assert classification_for_profile(
        sector="Consumer Defensive",
        industry="Household & Personal Products",
    )


def test_configured_crosswalk_fails_loudly_for_an_unknown_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = taxonomy_reference()
    crosswalk = {
        "schemaVersion": 1,
        "provider": "test-provider",
        "crosswalkVersion": "test",
        "taxonomy": "GICS",
        "taxonomyVersion": original.taxonomy_version,
        "matchPolicy": "profile only",
        "mappings": [
            {
                "profileKey": "semiconductors",
                "targetCode": "99999999",
                "confidence": 0.8,
            }
        ],
        "titleMappings": [],
    }
    path = tmp_path / "crosswalk.json"
    path.write_text(json.dumps(crosswalk), encoding="utf-8")
    monkeypatch.setenv("TRADING_MAX_GICS_CROSSWALK_PATH", str(path))
    taxonomy_reference.cache_clear()

    with pytest.raises(ValueError, match="unknown GICS node"):
        taxonomy_reference()

    taxonomy_reference.cache_clear()
