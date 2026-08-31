from pathlib import Path

import pytest
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import (
    ArtifactIntegrityError,
    ContentAddressedArtifactStore,
)


def test_content_addressed_store_is_deterministic_and_readable(tmp_path: Path) -> None:
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")
    first = store.put_json(
        key="research/technical.json",
        payload={"ticker": "BE", "rsi": 51.2},
        kind="technical",
        producer_version="technical-v1",
        quality=ArtifactQuality(status="verified", coverage="full"),
    )
    second = store.put_json(
        key="research/technical.json",
        payload={"ticker": "BE", "rsi": 51.2},
        kind="technical",
        producer_version="technical-v1",
        quality=ArtifactQuality(status="verified", coverage="full"),
    )

    assert first.ref.artifact_id == second.ref.artifact_id
    assert first.path == tmp_path / "artifacts" / "sha256" / first.ref.artifact_id
    loaded = store.get_json(first.ref.artifact_id)
    assert loaded.payload == {"ticker": "BE", "rsi": 51.2}
    assert loaded.ref.producer_version == "technical-v1"


def test_content_addressed_store_rejects_tampering_and_unsafe_keys(
    tmp_path: Path,
) -> None:
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")
    artifact = store.put_json(key="account/snapshot.json", payload={"value": 1})
    artifact.path.write_text('{"ref": {}, "payload": {}}', encoding="utf-8")

    with pytest.raises(ArtifactIntegrityError):
        store.get_json(artifact.ref.artifact_id)
    with pytest.raises(ValueError, match="unsafe artifact key"):
        store.put_json(key="../outside.json", payload={})


def test_content_addressed_store_supports_immutable_binary_artifacts(
    tmp_path: Path,
) -> None:
    store = ContentAddressedArtifactStore(tmp_path / "artifacts")
    artifact = store.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=b"Date,SyntheticNAVGBP\n2026-08-07,123.45\n",
        media_type="text/csv",
        producer_version="nav-v1",
    )

    loaded = store.get_bytes(artifact.ref.artifact_id)
    assert loaded.path.read_bytes().startswith(b"Date,")
    assert loaded.ref.media_type == "text/csv"
    assert store.get_ref(artifact.ref.artifact_id) == artifact.ref
