from __future__ import annotations

import gzip
import json

import pytest
from trading_max.infrastructure import ArtifactIntegrityError, ContentAddressedArtifactStore
from trading_max.infrastructure.history_chunks import HistoryChunks, canonical

KEY = "account/nav/valuation_history.json"


def points():
    return [
        {"bucket_at": "2026-01-02T00:05:00+01:00", "value": 10.25},
        {"bucket_at": "2026-01-02T00:10:00Z", "value": 11, "source_artifact_ids": None},
        {"bucket_at": "2026-01-01T12:10:00Z", "value": -2, "source_artifact_ids": ["a", "b"]},
        {"bucket_at": "2026-01-01T12:10:00Z", "value": 0, "source_artifact_ids": []},
    ]


def test_representation_preserves_original_bytes_order_timezone_and_field_absence(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path)
    original = store.put_json(key=KEY, payload={"points": points(), "label": "合成 fixture"})
    raw = original.path.read_bytes()
    descriptor = store.history.encode(raw)
    assert store.history.decode(descriptor) == raw
    assert [c["day"] for c in descriptor["chunks"]] == ["2026-01-01", "2026-01-02", "2026-01-01"]
    original.path.write_bytes(canonical(descriptor))
    reader = ContentAddressedArtifactStore(tmp_path)  # Default legacy writer, dual reader.
    assert reader.get_json(original.ref.artifact_id).payload["points"] == points()
    assert reader.get_ref(original.ref.artifact_id) == original.ref
    assert reader.logical_size(original.ref.artifact_id) == len(raw)
    assert reader.content_bytes(original.ref.artifact_id) == raw


@pytest.mark.parametrize("mode", ["legacy", "shadow", "chunked"])
def test_writer_modes_and_idempotency(tmp_path, mode):
    store = ContentAddressedArtifactStore(tmp_path, history_mode=mode)
    item = store.put_json(key=KEY, payload={"points": points()})
    again = store.put_json(key=KEY, payload={"points": points()})
    assert again.ref == item.ref
    assert store.get_json(item.ref.artifact_id).payload == item.payload
    physical = json.loads(item.path.read_bytes())
    if mode == "shadow":
        descriptor = json.loads(
            (tmp_path / "history-shadow" / f"{item.ref.artifact_id}.json").read_bytes()
        )
        assert store.history.decode(descriptor) == item.path.read_bytes()
        assert "payload" in physical  # Old runtime can still read this exact object.
    elif mode == "chunked":
        assert physical["$format"] == "trading-max-history-v1"
    else:
        assert not (tmp_path / "history-chunks").exists()


def test_provenance_rebuild_reuses_values_and_retention_rollover_is_lossless(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, history_mode="chunked")
    one = store.put_json(key=KEY, payload={"points": points()})
    rebuilt = [{**p, "source_artifact_ids": ["new-evidence"]} for p in points()]
    two = store.put_json(key=KEY, payload={"points": rebuilt})
    a, b = store.descriptor(one.ref.artifact_id), store.descriptor(two.ref.artifact_id)
    assert [c["values"] for c in a["chunks"]] == [c["values"] for c in b["chunks"]]
    assert a["chunks"][0]["sources"] != b["chunks"][0]["sources"]
    rolled = [*rebuilt[2:], {"bucket_at": "2026-01-03T01:00:00Z", "value": 12}]
    three = store.put_json(key=KEY, payload={"points": rolled})
    assert store.get_json(three.ref.artifact_id).payload["points"] == rolled
    assert store.get_json(one.ref.artifact_id).payload["points"] == points()


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_cached_ref_does_not_hide_missing_or_corrupt_blocks(tmp_path, damage):
    store = ContentAddressedArtifactStore(tmp_path, history_mode="chunked")
    item = store.put_json(key=KEY, payload={"points": points()})
    store.get_ref(item.ref.artifact_id)
    block = store.history.paths(store.descriptor(item.ref.artifact_id))[0]
    if damage == "missing":
        block.unlink()
    else:
        block.write_bytes(gzip.compress(b"[]"))
    with pytest.raises((ArtifactIntegrityError, FileNotFoundError)):
        store.get_ref(item.ref.artifact_id)
    with pytest.raises(ArtifactIntegrityError):
        store.get_json(item.ref.artifact_id)


def test_failed_chunk_write_never_publishes_artifact(tmp_path, monkeypatch):
    store = ContentAddressedArtifactStore(tmp_path, history_mode="chunked")

    def fail(_values):
        raise OSError("synthetic disk full")

    monkeypatch.setattr(store.history, "_store", fail)
    with pytest.raises(OSError, match="disk full"):
        store.put_json(key=KEY, payload={"points": points()})
    assert list(store.content_root.iterdir()) == []


def test_invalid_descriptors_and_symlinks_fail_closed(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, history_mode="chunked")
    item = store.put_json(key=KEY, payload={"points": points()})
    descriptor = json.loads(item.path.read_bytes())
    descriptor["chunks"][0]["values"]["sha256"] = "../escape"
    with pytest.raises(ValueError, match="digest"):
        store.history.decode(descriptor)
    with pytest.raises(ValueError, match="storage"):
        ContentAddressedArtifactStore(tmp_path, history_mode="unknown")
    external = tmp_path / "external"
    external.mkdir()
    linked = tmp_path / "linked"
    linked.mkdir()
    (linked / "history-chunks").symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        HistoryChunks(linked).encode(store.content_bytes(item.ref.artifact_id))


def test_large_day_splits_and_empty_history_roundtrips(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, history_mode="chunked")
    many = [{"bucket_at": "2026-01-01T00:00:00Z", "value": i} for i in range(1025)]
    item = store.put_json(key=KEY, payload={"points": many})
    assert [c["count"] for c in store.descriptor(item.ref.artifact_id)["chunks"]] == [512, 512, 1]
    assert store.get_json(item.ref.artifact_id).payload["points"] == many
    empty = store.put_json(key=KEY, payload={"points": []})
    assert store.get_json(empty.ref.artifact_id).payload == {"points": []}
