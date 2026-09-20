from __future__ import annotations

import gzip
import hashlib
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import pytest
from trading_max.backup_repository import BackupRepository, atomic_json
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.infrastructure.manifest_catalog import ManifestCatalog, canonical
from trading_max.infrastructure.object_packs import ObjectPacks, decode, encode


def test_independent_index_rebuild_and_byte_exact_records(tmp_path):
    store = ObjectPacks(tmp_path / "pool")
    records = {"json/a": b'{"x":null}', "json/b": "中文".encode(), "json/empty": b""}
    result = store.add(records)
    assert result["records"] == 3
    assert store.add(records)["records"] == 0
    copy = tmp_path / "copy"
    shutil.copytree(store.root, copy)
    store.close()
    shutil.rmtree(store.root)
    (copy / "index.sqlite3").unlink()
    recovery = ObjectPacks(copy)
    with pytest.raises(ValueError, match="rebuild"):
        recovery.read("json/a")
    assert recovery.rebuild()["records"] == 3
    keys = recovery.keys()
    assert {k: recovery.read(k) for k in keys} == records


def test_record_conflict_never_changes_published_bytes(tmp_path):
    store = ObjectPacks(tmp_path)
    store.add({"a": b"original"})
    with pytest.raises(ValueError, match="conflict"):
        store.add({"a": b"modified", "b": b"unpublished"})
    assert store.read("a") == b"original"
    assert not store.contains("b")


@pytest.mark.parametrize("damage", ["pack", "index", "delete"])
def test_corruption_invalidates_warm_cache(tmp_path, damage):
    store = ObjectPacks(tmp_path)
    store.add({"a": b"alpha", "b": b"beta"})
    assert store.read("a") == b"alpha"
    if damage == "pack":
        path = store.source("a")
        path.write_bytes(path.read_bytes()[:-1] + b"X")
    elif damage == "index":
        with sqlite3.connect(store.index) as db:
            db.execute("UPDATE records SET offset=1 WHERE key='a'")
    else:
        store.source("a").unlink()
    with pytest.raises((ValueError, FileNotFoundError)):
        store.read("a")


def test_corrupt_rebuild_preserves_old_index(tmp_path):
    store = ObjectPacks(tmp_path)
    store.add({"a": b"original"})
    before = store.index.read_bytes()
    (store.directory / ("a" * 64 + ".pack")).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        store.rebuild()
    assert store.index.read_bytes() == before
    assert store.read("a") == b"original"


def test_pack_write_failure_keeps_index_and_old_records(tmp_path, monkeypatch):
    from trading_max.infrastructure import object_packs

    store = ObjectPacks(tmp_path)
    store.add({"old": b"old"})

    def fail(*_):
        raise OSError("synthetic disk full")

    monkeypatch.setattr(object_packs, "atomic_bytes", fail)
    with pytest.raises(OSError):
        store.add({"new": b"new"})
    assert store.keys() == ["old"]


def test_uncommitted_index_rows_are_not_visible_and_rollback(tmp_path):
    store = ObjectPacks(tmp_path)
    store.add({"old": b"old"})
    other = ObjectPacks(tmp_path)
    assert other.read("old") == b"old"
    with closing(sqlite3.connect(store.index)) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM records WHERE key='old'")
        assert other.read("old") == b"old"
        connection.rollback()
    assert other.read("old") == b"old"


def test_parallel_readers_and_writers_publish_distinct_immutable_batches(tmp_path):
    store = ObjectPacks(tmp_path)
    store.add({"seed": b"seed"})

    def publish(n):
        writer = ObjectPacks(tmp_path)
        try:
            writer.add({f"item/{n}": str(n).encode()})
            return writer.read("seed")
        finally:
            writer.close()

    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(publish, range(16))) == [b"seed"] * 16
    assert len(store.keys()) == 17
    store.rebuild()
    assert len(store.keys()) == 17


@pytest.mark.parametrize("key", ["../x", "/x", "a/../b", "a//b", "a\\b", ".", ""])
def test_unsafe_keys_fail_closed(key):
    with pytest.raises(ValueError):
        encode({key: b"bytes"})


def test_malformed_and_oversize_frames_fail_closed(monkeypatch):
    from trading_max.infrastructure import object_packs

    raw = encode({"a": b"hello"})
    for invalid in [b"", raw[:12], raw[:-1], raw + b"extra"]:
        with pytest.raises(ValueError):
            decode(invalid)
    monkeypatch.setattr(object_packs, "MAX_BYTES", 4)
    with pytest.raises(ValueError):
        decode(raw)


def test_symlinked_pool_is_rejected(tmp_path):
    external = tmp_path / "external"
    external.mkdir()
    link = tmp_path / "link"
    link.symlink_to(external)
    with pytest.raises(ValueError, match="symlink"):
        ObjectPacks(link).add({"key": b"value"})


def pack_artifacts(store):
    records = {}
    loose = []
    for directory, prefix in [("json-chunks", "json"), ("history-chunks", "history")]:
        for path in (store.root / directory).rglob("*.gz"):
            records[prefix + "/" + path.stem] = gzip.decompress(path.read_bytes())
            loose.append(path)
    for path in store.content_root.glob("*"):
        records["artifact/" + path.name] = path.read_bytes()
        loose.append(path)
    store.packs.add(records)
    for path in loose:
        path.unlink()


def test_packed_artifacts_keep_identity_downloads_and_idempotent_writes(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked", history_mode="chunked")
    payloads = [
        ("small.json", {"null": None, "value": "10.000000003", "unknown": "中文"}),
        ("large.json", {"rows": [{"n": i, "s": "合成" * 100} for i in range(1000)]}),
        (
            "account/nav/valuation_history.json",
            {
                "points": [
                    {"bucket_at": "2026-01-01T00:00:00Z", "value": 10.123456789},
                    {
                        "bucket_at": "2026-01-01T00:10:00Z",
                        "value": None,
                        "source_artifact_ids": None,
                    },
                ]
            },
        ),
    ]
    originals = [store.put_json(key=k, payload=p) for k, p in payloads]
    raw = [store.content_bytes(o.ref.artifact_id) for o in originals]
    pack_artifacts(store)
    for original, expected in zip(originals, raw, strict=True):
        assert store.get_json(original.ref.artifact_id).payload == original.payload
        assert store.get_ref(original.ref.artifact_id) == original.ref
        assert store.content_bytes(original.ref.artifact_id) == expected
        assert store.logical_size(original.ref.artifact_id) == len(expected)
        assert store.requires_decoding(original.ref.artifact_id)
        assert store.put_json(key=original.ref.key, payload=original.payload).ref == original.ref
    assert len(store.artifact_ids()) == 3
    assert list(store.content_root.glob("*")) == []


def test_manifest_catalog_preserves_all_versions_deletions_and_exact_download(tmp_path):
    packs = ObjectPacks(tmp_path / "pool")
    catalog = ManifestCatalog(packs)
    expected = []
    for n in range(40):
        files = {f"path/{i}": {"sha256": f"{i:064x}", "size": i, "mode": 384} for i in range(100)}
        files.pop("path/5", None)
        files[f"new/{n}"] = {"sha256": "a" * 64, "size": n, "optional": None}
        raw = canonical({"id": str(n), "files": files, "unknown": ["中文", None]})
        descriptor = catalog.encode(raw, str(n))
        expected.append((descriptor, raw))
    assert len(packs.keys("entry/")) == 139
    copy = tmp_path / "copy"
    packs.close()
    shutil.copytree(packs.root, copy)
    shutil.rmtree(packs.root)
    (copy / "index.sqlite3").unlink()
    recovered = ObjectPacks(copy)
    recovered.rebuild()
    for descriptor, raw in expected:
        assert ManifestCatalog(recovered).decode(descriptor) == raw
    original = b'{ "files": {}, "unknown": null }\n'
    special = ManifestCatalog(recovered).encode(original, "unformatted")
    assert ManifestCatalog(recovered).decode(special) == original


def test_fully_packed_independent_backup_restores_without_live_state(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE fixture (v TEXT)")
    store = SnapshotStore(state)
    original = store.artifacts.put_json(key="example.json", payload={"synthetic": [None, 1, "2.0"]})
    snapshot = store.publish(scope="accounts", source="test", artifacts=[original])
    raw = store.artifacts.content_bytes(original.ref.artifact_id)
    pack_artifacts(store.artifacts)
    repo = BackupRepository(tmp_path / "repository")
    created = repo.create(state)  # Even a physical request normalizes virtual artifacts.
    manifest = repo.manifest_bytes(created["id"])
    records = {}
    loose = list(repo.blobs.rglob("*.gz"))
    for path in loose:
        records["blob/" + path.stem] = gzip.decompress(path.read_bytes())
    repo.packs.add(records)
    for path in loose:
        path.unlink()
    atomic_json(
        repo.manifest_path(created["id"]), repo.manifest_catalog.encode(manifest, created["id"])
    )
    assert repo.manifest_bytes(created["id"]) == manifest
    repo.packs.close()
    shutil.rmtree(state)
    (repo.root / "object-packs/index.sqlite3").unlink()
    repo.packs.rebuild()
    restored = tmp_path / "restored"
    assert repo.restore(created["id"], restored)["snapshotRunId"] == snapshot.manifest.run_id
    assert (restored / "artifacts/sha256" / original.ref.artifact_id).read_bytes() == raw
    assert not (restored / "artifacts/object-packs").exists()
    assert (
        hashlib.sha256(repo.manifest_bytes(created["id"])).digest()
        == hashlib.sha256(manifest).digest()
    )


def test_interrupted_commit_is_recovered_before_catalog_ids_are_reused(tmp_path, monkeypatch):
    from trading_max.infrastructure import object_packs

    store = ObjectPacks(tmp_path)
    store.add({"entry/0000000000000001": canonical(["old", {"size": 1}])})
    write = object_packs.atomic_bytes

    def interrupt(path, content):
        write(path, content)
        raise OSError("synthetic interruption after pack fsync")

    with monkeypatch.context() as patch:
        patch.setattr(object_packs, "atomic_bytes", interrupt)
        with pytest.raises(OSError):
            store.add({"entry/0000000000000002": canonical(["interrupted", {"size": 2}])})
    assert not store.contains("entry/0000000000000002")
    catalog = ManifestCatalog(store)
    raw = canonical({"files": {"third": {"size": 3}}, "id": "third"})
    descriptor = catalog.encode(raw, "third")
    assert store.read("entry/0000000000000002") == canonical(["interrupted", {"size": 2}])
    assert catalog.decode(descriptor) == raw
    store.rebuild()
    assert catalog.decode(descriptor) == raw


def test_legacy_tar_backup_captures_consistent_packed_state(tmp_path):
    import tarfile

    from trading_max.backup import create_backup

    state = tmp_path / "source"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as database:
        database.execute("CREATE TABLE sample (v TEXT)")
    store = SnapshotStore(state)
    item = store.artifacts.put_json(key="sample.json", payload={"value": "synthetic"})
    snapshot = store.publish(scope="accounts", source="test", artifacts=[item])
    pack_artifacts(store.artifacts)
    archive = create_backup(state, tmp_path / "archives")
    store.artifacts.packs.close()
    shutil.rmtree(state)
    with tarfile.open(archive) as handle:
        handle.extractall(tmp_path / "copy", filter="data")
    assert (
        SnapshotStore(tmp_path / "copy/state").latest().manifest.run_id == snapshot.manifest.run_id
    )


def test_batch_reads_preserve_request_order_and_detect_bad_locators(tmp_path):
    store = ObjectPacks(tmp_path)
    store.add({"first": b"alpha", "second": b"beta"})
    store.add({"third": b"gamma"})
    assert store.read_many(["third", "first", "third"]) == [b"gamma", b"alpha", b"gamma"]
    with pytest.raises(FileNotFoundError):
        store.read_many(["first", "missing"])
    with sqlite3.connect(store.index) as db:
        db.execute("UPDATE records SET size=3 WHERE key='second'")
    with pytest.raises(ValueError, match="locator"):
        store.read_many(["third", "second"])
