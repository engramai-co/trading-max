from __future__ import annotations

from pathlib import Path

import pytest

from services.api.trading_max_api.artifacts import ArtifactStore


def test_typed_snapshot_is_immutable_and_content_addressed(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    json_artifact = store.immutable_artifacts.put_json(
        key="research/technical.json",
        payload={"as_of": "2026-08-07", "rows": [{"ticker": "BE"}]},
        kind="technical",
        producer_version="technical-v2",
    )
    csv_artifact = store.immutable_artifacts.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=b"Date,SyntheticNAVGBP\n2026-08-07,100\n",
        kind="nav_series",
        media_type="text/csv",
        producer_version="nav-v1",
    )
    manifest = store.publish_typed(
        scope="all",
        source="test",
        artifacts=[json_artifact, csv_artifact],
    )

    latest = store.latest_manifest()
    assert latest is not None
    assert latest.run_id == manifest.run_id
    assert (store.immutable_snapshots.snapshots_root / manifest.run_id / "manifest.json").is_file()
    assert {item.key for item in manifest.artifacts} == {
        "research/technical.json",
        "account/nav/daily_nav_a.csv",
    }
    assert all(len(item.sha256) == 64 for item in manifest.artifacts)
    assert store.read_json(manifest.run_id, "research/technical.json")["rows"][0]["ticker"] == "BE"
    assert "SyntheticNAVGBP" in store.read_text(
        manifest.run_id,
        "account/nav/daily_nav_a.csv",
    )


def test_artifact_keys_cannot_escape_snapshot(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    artifact = store.immutable_artifacts.put_json(
        key="research/technical.json",
        payload={"rows": []},
        kind="technical",
        producer_version="fixture-v1",
    )
    manifest = store.publish_typed(
        scope="research",
        source="fixture",
        artifacts=[artifact],
    )

    with pytest.raises(ValueError, match="unsafe artifact key"):
        store.artifact_path(manifest.run_id, "../latest.json")


def test_latest_manifest_is_empty_before_first_snapshot(tmp_path: Path) -> None:
    assert ArtifactStore(tmp_path / "runtime").latest_manifest() is None


def test_list_manifests_includes_typed_snapshot_history(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    artifact = store.immutable_artifacts.put_json(
        key="research/technical.json",
        payload={"rows": []},
        kind="technical",
        producer_version="fixture-v1",
    )
    published = store.publish_typed(
        scope="research",
        source="fixture",
        artifacts=[artifact],
    )

    listed = store.list_manifests()

    assert [item.run_id for item in listed] == [published.run_id]


def test_latest_manifest_cache_tracks_cross_process_publication(tmp_path: Path) -> None:
    data_root = tmp_path / "runtime"
    reader = ArtifactStore(data_root)
    writer = ArtifactStore(data_root)
    assert reader.latest_manifest() is None

    artifact = writer.immutable_artifacts.put_json(
        key="research/technical.json",
        payload={"rows": [{"ticker": "GOOGL"}]},
        kind="technical",
        producer_version="fixture-v1",
    )
    first = writer.publish_typed(
        scope="research",
        source="fixture",
        artifacts=[artifact],
    )
    assert reader.latest_manifest().run_id == first.run_id

    second = writer.publish_typed(
        scope="research",
        source="fixture",
        artifacts=[artifact],
    )
    assert reader.latest_manifest().run_id == second.run_id
    assert [item.run_id for item in reader.list_manifests(limit=2)] == [
        second.run_id,
        first.run_id,
    ]
