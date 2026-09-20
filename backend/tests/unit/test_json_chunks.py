import shutil

import pytest
from trading_max.infrastructure import ArtifactIntegrityError, ContentAddressedArtifactStore
from trading_max.infrastructure.history_chunks import canonical
from trading_max.research.disclosures import ResearchEvidenceProvider


def payload():
    return {
        "series": [
            {"date": f"2026-{i:05d}", "value": i / 7, "unchanged": "合成" * 20} for i in range(1600)
        ],
        "nested": {"absence": None, "list": [], "object": {}, "description": "long" * 14000},
    }


def test_shared_subtrees_retain_exact_envelope_and_append_reuses_prior_data(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked")
    data = payload()
    one = store.put_json(key="research/test.json", payload=data)
    before = set(store.physical_paths(store.descriptor(one.ref.artifact_id)))
    data["series"].append({"date": "new", "value": 99})
    two = store.put_json(key="research/test.json", payload=data)
    after = set(store.physical_paths(store.descriptor(two.ref.artifact_id)))
    assert len(before & after) >= len(before) - 4
    reader = ContentAddressedArtifactStore(tmp_path)
    assert reader.get_json(one.ref.artifact_id).payload == payload()
    assert reader.get_json(two.ref.artifact_id).payload == data
    assert reader.content_bytes(two.ref.artifact_id) == canonical(
        {"ref": two.ref.model_dump(mode="json", by_alias=False), "payload": data}
    )
    assert reader.logical_size(two.ref.artifact_id) == len(
        reader.content_bytes(two.ref.artifact_id)
    )


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_reference_cache_checks_changed_physical_dependency(tmp_path, damage):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked")
    item = store.put_json(key="test.json", payload=payload())
    store.get_ref(item.ref.artifact_id)
    block = store.physical_paths(store.descriptor(item.ref.artifact_id))[0]
    if damage == "missing":
        block.unlink()
    else:
        block.write_bytes(b"bad-gzip")
    with pytest.raises((ArtifactIntegrityError, FileNotFoundError)):
        store.get_ref(item.ref.artifact_id)


def test_invalid_tree_budget_duplicate_keys_and_symlink_fail_closed(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked")
    item = store.put_json(key="test.json", payload=payload())
    descriptor = store.descriptor(item.ref.artifact_id)
    for tree in (
        ["blob", "../bad", 1],
        ["blob", "a" * 64, 10**10],
        ["map", [["x", ["blob", "a" * 64, 1]], ["x", ["blob", "a" * 64, 1]]]],
    ):
        changed = {**descriptor, "tree": tree}
        with pytest.raises(ValueError):
            store.json_chunks.paths(changed)
    external = tmp_path / "external"
    shutil.move(store.json_chunks.root, external)
    store.json_chunks.root.symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        store.json_chunks.paths(descriptor)


def test_chunk_failure_never_publishes_envelope(tmp_path, monkeypatch):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked")
    monkeypatch.setattr(
        store.json_chunks, "_store", lambda _: (_ for _ in ()).throw(OSError("disk full"))
    )
    with pytest.raises(OSError, match="disk full"):
        store.put_json(key="test.json", payload=payload())
    assert not list(store.content_root.iterdir())


def test_research_cache_dual_reader_preserves_unicode_and_atomic_failure(tmp_path, monkeypatch):
    provider = ResearchEvidenceProvider(tmp_path)
    text = "<html>合成 report</html>" * 1000
    path = tmp_path / "fixture.html"
    provider._write_cache(path, text)
    assert path.read_text() == text
    monkeypatch.setenv("TRADING_MAX_ARTIFACT_STORAGE", "chunked")
    provider._write_cache(path, text)
    assert path.stat().st_size < len(text.encode()) / 10
    assert provider._read_cache(path) == text
    assert not list(tmp_path.glob(".pending-*"))
    path.write_bytes(path.read_bytes()[:-5])
    with pytest.raises(ValueError):
        provider._read_cache(path)
