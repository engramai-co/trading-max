from pathlib import Path

import pytest
from trading_max.application import StageContext
from trading_max.application.research_stages import TypedPublishSnapshotStage
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import SnapshotIntegrityError, SnapshotStore


def test_snapshot_store_publishes_complete_content_addressed_run(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path / "state")
    artifact = store.artifacts.put_json(
        key="research/technical.json",
        payload={"ticker": "TSM", "score": 74},
        kind="technical",
        producer_version="technical-v1",
        quality=ArtifactQuality(status="verified", coverage="full"),
    )

    published = store.publish(
        scope="research",
        source="test",
        artifacts=[artifact],
    )

    loaded = store.latest()
    assert loaded is not None
    assert loaded.manifest.run_id == published.manifest.run_id
    assert loaded.manifest.artifacts[0].artifact_id == artifact.ref.artifact_id
    assert store.artifacts.get_json(artifact.ref.artifact_id).payload == {
        "ticker": "TSM",
        "score": 74,
    }


def test_snapshot_store_rejects_a_tampered_latest_manifest(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "state")
    artifact = store.artifacts.put_json(
        key="account/snapshot.json",
        payload={"ok": True},
    )
    store.publish(scope="accounts", source="test", artifacts=[artifact])
    manifest_path = next((tmp_path / "state" / "snapshots").glob("*/manifest.json"))
    manifest_path.write_text("{}\n", encoding="utf-8")

    with pytest.raises(SnapshotIntegrityError):
        store.latest()


def test_partial_snapshot_publish_preserves_previous_artifacts(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "state")
    account = store.artifacts.put_json(
        key="account/invest.json",
        payload={"value": 1},
    )
    technical = store.artifacts.put_json(
        key="research/technical.json",
        payload={"value": 2},
    )
    store.publish(scope="all", source="first", artifacts=[account])
    previous = store.latest()
    assert previous is not None
    refs = {ref.key: ref for ref in previous.manifest.artifacts}
    refs[technical.ref.key] = technical.ref
    published = store.publish(
        scope="research",
        source="partial",
        artifacts=list(refs.values()),
    )

    assert {ref.key for ref in published.manifest.artifacts} == {
        "account/invest.json",
        "research/technical.json",
    }


def test_partial_research_publish_merges_unrefreshed_rows(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path / "state")
    technical_old = store.artifacts.put_json(
        key="research/technical.json",
        payload={
            "tickers": ["TSM", "NVDA", "BE"],
            "rows": [
                {"ticker": "TSM", "score": 74},
                {"ticker": "NVDA", "score": 61},
                {"ticker": "BE", "score": 47},
            ],
        },
        kind="technical",
        producer_version="technical-v4",
    )
    store.publish(
        scope="research",
        source="full",
        artifacts=[technical_old],
    )

    stage = TypedPublishSnapshotStage(store.artifacts, store)
    technical_new = store.artifacts.put_json(
        key="research/technical.json",
        payload={
            "tickers": ["BE"],
            "rows": [{"ticker": "BE", "score": 52}],
        },
        kind="technical",
        producer_version="technical-v4",
    )
    stage.run(
        StageContext(
            job_id="be-job",
            scope="research",
            tickers=("BE",),
            upstream_artifact_ids=(technical_new.ref.artifact_id,),
        )
    )

    latest = store.latest()
    assert latest is not None
    ref = next(ref for ref in latest.manifest.artifacts if ref.key == "research/technical.json")
    payload = store.artifacts.get_json(ref.artifact_id).payload
    assert {row["ticker"] for row in payload["rows"]} == {"TSM", "NVDA", "BE"}
    assert next(row for row in payload["rows"] if row["ticker"] == "BE")["score"] == 52
    assert payload["tickers"] == ["TSM", "NVDA", "BE"]


def test_partial_research_publish_merges_market_snapshot_nested_rows(
    tmp_path: Path,
) -> None:
    store = SnapshotStore(tmp_path / "state")
    market_old = store.artifacts.put_json(
        key="research/market_snapshot.json",
        payload={
            "tickers": ["TSM", "BE"],
            "technical": {
                "tickers": ["TSM", "BE"],
                "rows": [
                    {"ticker": "TSM", "score": 74},
                    {"ticker": "BE", "score": 47},
                ],
            },
            "options": {
                "tickers": ["TSM", "BE"],
                "rows": [
                    {"ticker": "TSM", "walls": 1},
                    {"ticker": "BE", "walls": 2},
                ],
            },
        },
        kind="market",
        producer_version="market-snapshot-v3",
    )
    store.publish(scope="research", source="full", artifacts=[market_old])

    stage = TypedPublishSnapshotStage(store.artifacts, store)
    market_new = store.artifacts.put_json(
        key="research/market_snapshot.json",
        payload={
            "tickers": ["BE"],
            "technical": {
                "tickers": ["BE"],
                "rows": [{"ticker": "BE", "score": 52}],
            },
            "options": {
                "tickers": ["BE"],
                "rows": [{"ticker": "BE", "walls": 9}],
            },
        },
        kind="market",
        producer_version="market-snapshot-v3",
    )
    stage.run(
        StageContext(
            job_id="be-job",
            scope="research",
            tickers=("BE",),
            upstream_artifact_ids=(market_new.ref.artifact_id,),
        )
    )

    latest = store.latest()
    assert latest is not None
    ref = next(
        ref for ref in latest.manifest.artifacts if ref.key == "research/market_snapshot.json"
    )
    payload = store.artifacts.get_json(ref.artifact_id).payload
    assert {row["ticker"] for row in payload["technical"]["rows"]} == {"TSM", "BE"}
    assert {row["ticker"] for row in payload["options"]["rows"]} == {"TSM", "BE"}
    assert payload["tickers"] == ["TSM", "BE"]


def test_intraday_snapshot_does_not_invoke_synthesis_callback(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "state")
    artifact = store.artifacts.put_json(
        key="account/nav/intraday_anchors.json",
        payload={"points": []},
    )
    callbacks: list[str] = []
    stage = TypedPublishSnapshotStage(
        store.artifacts,
        store,
        lambda _snapshot, trigger: callbacks.append(trigger),
    )
    stage.run(
        StageContext(
            job_id="intraday-job",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=(artifact.ref.artifact_id,),
        )
    )
    assert callbacks == []
