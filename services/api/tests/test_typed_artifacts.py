from pathlib import Path

from trading_max.infrastructure import ContentAddressedArtifactStore

from services.api.trading_max_api.artifacts import ArtifactStore


def test_api_transport_reads_payloads_from_immutable_typed_snapshot(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "state")
    artifact_store = ContentAddressedArtifactStore(tmp_path / "state" / "artifacts")
    artifact = artifact_store.put_json(
        key="research/technical.json",
        payload={"rows": [{"ticker": "BE"}]},
        kind="technical",
        producer_version="technical-v1",
    )

    manifest = store.publish_typed(
        scope="research",
        source="typed-test",
        artifacts=[artifact],
    )

    assert store.latest_manifest() is not None
    assert manifest.run_id == store.latest_manifest().run_id
    assert store.read_json(manifest.run_id, "research/technical.json") == {
        "rows": [{"ticker": "BE"}]
    }
