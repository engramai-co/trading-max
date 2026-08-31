from __future__ import annotations

import json
from pathlib import Path

from trading_max.infrastructure import ContentAddressedArtifactStore

from services.api.trading_max_api.models import SecuritySearchResult
from services.api.trading_max_api.taxonomy_workflow import TaxonomyWorkflowManager
from services.api.trading_max_api.watchlist import WatchlistStore


class _UnavailableProvider:
    fake = True
    name = "fake"
    model = "none"


def test_unavailable_provider_persists_audit_without_fabricating_taxonomy(
    tmp_path: Path,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="GOOGL",
            name="Alphabet Inc Class A",
            exchange="NASDAQ",
            bloomberg_ticker="GOOGL US Equity",
            figi="BBG009S39JX6",
        )
    )
    gics_before = watchlist.items()[0].gics
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    manager = TaxonomyWorkflowManager(tmp_path, watchlist, artifacts)

    artifact_ids = manager.execute(
        {
            "snapshotRunId": "research-20260823",
            "dataAsOf": "2026-08-23",
            "instruments": [{"ticker": "GOOGL", "name": "Alphabet Inc Class A"}],
        },
        _UnavailableProvider(),
    )

    assert len(artifact_ids) == 1
    item = watchlist.items()[0]
    assert item.ticker == "GOOGL"
    assert item.taxonomy_status == "unclassified"
    assert item.taxonomy_version is None
    assert item.taxonomy_decision_id
    assert item.category_id == ""
    assert item.research_theme_id is None
    assert item.gics == gics_before

    audit_path = tmp_path / "taxonomy-workflows" / "GOOGL" / f"{item.taxonomy_decision_id}.json"
    payload = json.loads(audit_path.read_text(encoding="utf-8"))
    assert payload["decisionId"] == item.taxonomy_decision_id
    assert payload["status"] == "unclassified"
    assert payload["outcome"] == "remain_pending"
    assert payload["judgments"] == []
    assert payload["provider"] == "deterministic"
    assert payload["model"] == "none"
    assert len(payload["inputHash"]) == 64

    immutable = artifacts.get_json(artifact_ids[0])
    assert immutable.ref.kind == "taxonomy_decision"
    assert immutable.ref.key == (f"taxonomy-workflows/GOOGL/{item.taxonomy_decision_id}.json")
    assert immutable.payload == payload


def test_available_provider_marks_new_item_classifying_without_blocking_research(
    tmp_path: Path,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    item = watchlist.add(
        SecuritySearchResult(
            ticker="BE",
            name="Bloom Energy Corp",
            exchange="NYSE",
            bloomberg_ticker="BE US Equity",
            figi="BBG001BBH6X2",
        )
    )
    manager = TaxonomyWorkflowManager(
        tmp_path,
        watchlist,
        ContentAddressedArtifactStore(tmp_path / "artifacts"),
    )

    manager.record_pending(item, provider_available=True)

    recorded = watchlist.items()[0]
    assert recorded.taxonomy_status == "classifying"
    assert recorded.category_id == ""
    assert recorded.research_theme_id is None
    assert recorded.status == "pending"
    assert recorded.taxonomy_decision_id
    audit_path = tmp_path / "taxonomy-workflows" / "BE" / f"{recorded.taxonomy_decision_id}.json"
    payload = json.loads(audit_path.read_text(encoding="utf-8"))
    assert payload["status"] == "classifying"
    assert payload["outcome"] == "remain_pending"


def test_provider_can_retry_a_previous_no_provider_decision(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    item = watchlist.add(
        SecuritySearchResult(
            ticker="GOOGL",
            name="Alphabet Inc Class A",
            exchange="NASDAQ",
            bloomberg_ticker="GOOGL US Equity",
            figi="",
        )
    )
    manager = TaxonomyWorkflowManager(
        tmp_path,
        watchlist,
        ContentAddressedArtifactStore(tmp_path / "artifacts"),
    )
    manager.record_pending(item, provider_available=False)
    unavailable = watchlist.items()[0]
    assert unavailable.taxonomy_status == "unclassified"
    assert unavailable.taxonomy_version is None

    class _AvailableProvider:
        fake = False
        name = "opencode"
        model = "deepseek-v4-flash"
        api_key = "test"
        base_url = "https://example.test/v1"

    class _Judge:
        def __init__(self, _provider: object) -> None:
            pass

        def __call__(self, stage: str, role: str, _prompt: str, _payload: object) -> dict:
            if stage == "candidate-proposal":
                return {
                    "verdict": "propose",
                    "themeId": "digital-advertising-platforms",
                    "labelZh": "数字广告平台",
                    "labelEn": "Digital advertising platforms",
                    "descriptionZh": "以数字广告和搜索分发为核心的全球平台。",
                    "descriptionEn": "Global platforms centered on digital advertising and search distribution.",
                    "inclusionCriteria": ["Material digital-advertising platform revenue"],
                    "exclusionCriteria": ["Advertising agencies without a scaled platform"],
                    "confidence": 0.94,
                }
            if stage == "candidate-critique":
                return {"verdict": "accept", "confidence": 0.9}
            if stage == "admission":
                return {"verdict": "create_new", "confidence": 0.9}
            return {"verdict": "no_match", "confidence": 0.9}

    import services.api.trading_max_api.taxonomy_workflow as workflow_module

    monkeypatch.setattr(workflow_module, "ConfiguredTaxonomyJudge", _Judge)
    manager.execute(
        {
            "snapshotRunId": "research-20260823",
            "dataAsOf": "2026-08-23",
            "instruments": [{"ticker": "GOOGL", "name": "Alphabet Inc Class A"}],
        },
        _AvailableProvider(),
    )

    assigned = watchlist.items()[0]
    assert assigned.taxonomy_status == "assigned"
    assert assigned.category_id == "digital-advertising-platforms"
    assert assigned.taxonomy_version == 2
