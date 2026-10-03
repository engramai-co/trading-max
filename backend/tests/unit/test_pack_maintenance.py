from __future__ import annotations

import gzip
import hashlib
import shutil
import sqlite3
from pathlib import Path

import pytest
from trading_max.backup_repository import BackupRepository
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.infrastructure.object_packs import ObjectPacks
from trading_max.pack_maintenance import (
    LoosePacker,
    PackWindow,
    _nightly_batch,
    compact_manifests,
    enable,
    pack_repository,
    pack_state,
)


def initialized_state(path):
    path.mkdir()
    with sqlite3.connect(path / "trading_max.db") as db:
        db.execute("CREATE TABLE test(value INTEGER)")
    return path


def populate(state, n):
    store = ContentAddressedArtifactStore(
        state / "artifacts", history_mode="chunked", storage_mode="chunked"
    )
    item = store.put_json(
        key="account/nav/valuation_history.json",
        payload={
            "points": [
                {
                    "bucket_at": f"2026-01-{i + 1:02}T12:00:00Z",
                    "value": i + 0.000000123,
                    "source_artifact_ids": ["synthetic"],
                }
                for i in range(n)
            ]
        },
    )
    other = store.put_json(
        key="large.json", payload={"rows": [{"v": i, "s": "synthetic" * 100} for i in range(200)]}
    )
    SnapshotStore(state, artifacts=store).publish(
        scope="accounts", source="fixture", artifacts=[item, other]
    )
    return store, {a.ref.artifact_id: store.content_bytes(a.ref.artifact_id) for a in [item, other]}


def test_bounded_batches_and_independent_recovery_after_daily_increments(tmp_path):
    state = initialized_state(tmp_path / "state")
    repo = BackupRepository(tmp_path / "repository")
    expected = {}
    backups = []
    enable(repo.root)
    for day in range(1, 22):
        store, artifacts = populate(state, day)
        expected.update(artifacts)
        before = {p.name: p.read_bytes() for p in store.packs.directory.glob("*.pack")}
        # Several bounded batches exercise mixed loose/sealed reads.
        while True:
            result = pack_state(state, tmp_path / "journals/state", max_files=3)
            assert result["convertedFiles"] <= 3
            if result["convertedFiles"] == 0:
                break
        for name, raw in before.items():
            assert (store.packs.directory / name).read_bytes() == raw
        backup = repo.create(state, artifact_encoding="logical")
        backups.append((backup["id"], repo.manifest_bytes(backup["id"])))
        for _ in range(30):
            result = pack_repository(repo, tmp_path / "journals/backups", max_files=4)
            assert result["convertedFiles"] <= 4
            if result["convertedFiles"] == 0:
                break
        assert SnapshotStore(state).latest()
    for backup_id, raw in backups:
        assert repo.manifest_bytes(backup_id) == raw
    # There is no replay dependency on old live records or the old index file.
    shutil.rmtree(state)
    for pool in [repo.packs, repo.packed_store.packs]:
        pool.close()
        if pool.index.exists():
            pool.index.unlink()
            pool.rebuild()
    recovery = tmp_path / "recovery"
    repo.restore(backups[-1][0], recovery)
    reader = ContentAddressedArtifactStore(recovery / "artifacts")
    for key, raw in expected.items():
        assert reader.content_bytes(key) == raw
    assert not list((tmp_path / "journals").rglob("pack-*.json"))


def test_old_manifest_date_and_bytes_survive_compaction(tmp_path):
    state = initialized_state(tmp_path / "state")
    populate(state, 2)
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state)
    path = Path(backup["manifest"])
    raw, before = path.read_bytes(), path.stat().st_mtime_ns
    assert compact_manifests(repo)["convertedManifests"] == 1
    assert path.stat().st_mtime_ns == before
    assert repo.manifest_bytes(backup["id"]) == raw
    assert compact_manifests(repo)["convertedManifests"] == 0
    repo.verify(backup["id"])


def test_interruption_during_retirement_resumes_from_sealed_bytes(tmp_path, monkeypatch):
    root = tmp_path / "source"
    root.mkdir()
    pool = ObjectPacks(root / "packs")
    sources = []
    for i in range(3):
        path = root / str(i)
        path.write_bytes(str(i).encode())
        sources.append((path, str(i), "raw"))
    packer = LoosePacker(root, pool, tmp_path / "journals")
    unlink = Path.unlink

    def interrupt(path, *args, **kwargs):
        if path == sources[1][0]:
            raise OSError("synthetic power loss")
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupt)
        with pytest.raises(OSError):
            packer.run(sources)
    assert not sources[0][0].exists()
    assert sources[1][0].exists()
    packer.recover()
    for path, key, _ in sources:
        assert not path.exists()
        assert pool.read(key) == key.encode()
    assert not list(packer.journals.glob("pack-*.json"))


def test_changed_original_is_never_deleted_on_retry(tmp_path, monkeypatch):
    root = tmp_path / "source"
    root.mkdir()
    original = root / "original"
    original.write_bytes(b"one")
    pool = ObjectPacks(root / "packs")
    packer = LoosePacker(root, pool, tmp_path / "journals")
    add = pool.add

    def concurrent_change(records):
        result = add(records)
        original.write_bytes(b"two")
        return result

    monkeypatch.setattr(pool, "add", concurrent_change)
    with pytest.raises(ValueError, match="changed"):
        packer.run([(original, "original", "raw")])
    with pytest.raises(ValueError, match="changed"):
        packer.recover()
    assert original.read_bytes() == b"two"
    assert pool.read("original") == b"one"


def test_corrupt_compressed_source_is_preserved(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    name = hashlib.sha256(b"good").hexdigest()
    source = root / (name + ".gz")
    source.write_bytes(gzip.compress(b"wrong"))
    pool = ObjectPacks(root / "pool")
    with pytest.raises(ValueError, match="checksum"):
        LoosePacker(root, pool, tmp_path / "journals").run([(source, name, "gzip")])
    assert source.is_file()
    assert not pool.index.exists()


def test_pack_reader_probe_exercises_the_installed_reader():
    from trading_max.storage_compatibility import _PACK_PROBE

    exec(_PACK_PROBE, {})  # noqa: S102 - fixed synthetic compatibility probe


def test_hot_classification_does_not_decode_or_traverse_source_ancestry(tmp_path, monkeypatch):
    state = tmp_path / "state"
    store = ContentAddressedArtifactStore(state / "artifacts")
    parent = store.put_json(key="source.json", payload={"value": "original source"})
    current = store.put_json(
        key="view.json",
        payload={"value": "current output"},
        dependency_artifact_ids=[parent.ref.artifact_id],
    )
    expected = {
        item.ref.artifact_id: store.content_bytes(item.ref.artifact_id)
        for item in [parent, current]
    }
    SnapshotStore(state, artifacts=store).publish(
        scope="accounts", source="fixture", artifacts=[current]
    )

    def must_not_decode(*args, **kwargs):
        pytest.fail("classification decoded a source envelope")

    monkeypatch.setattr(ContentAddressedArtifactStore, "get_ref", must_not_decode)
    result = pack_state(state, tmp_path / "journals")
    assert result["convertedFiles"] == 2
    packed = ContentAddressedArtifactStore(state / "artifacts")
    assert packed.packs.source("artifact/" + parent.ref.artifact_id) != packed.packs.source(
        "artifact/" + current.ref.artifact_id
    )
    for aid, raw in expected.items():
        assert packed.content_bytes(aid) == raw


@pytest.mark.parametrize("reason", ["time-budget", "deployment-request"])
def test_pack_yields_after_a_complete_batch_and_resumes_exact_bytes(tmp_path, monkeypatch, reason):
    from trading_max import pack_maintenance

    clock = [0.0]
    requested = [False]
    monkeypatch.setattr(pack_maintenance.time, "monotonic", lambda: clock[0])
    root = tmp_path / "source"
    root.mkdir()
    candidates = []
    expected = {}
    for i in range(3):
        source = root / str(i)
        raw = f"row{i}".encode()
        source.write_bytes(raw)
        candidates.append((source, str(i), "raw"))
        expected[str(i)] = raw
    packer = LoosePacker(root, ObjectPacks(root / "pool"), tmp_path / "journals")

    def after_batch(_):
        assert not list(packer.journals.glob("pack-*.json"))
        if reason == "time-budget":
            clock[0] = 2
        else:
            requested[0] = True

    window = PackWindow(1, should_yield=lambda: requested[0], progress=after_batch)
    result = packer.run(candidates, target_bytes=4, window=window)
    assert result["convertedFiles"] == 1
    assert window.reason == reason
    assert not candidates[0][0].exists()
    assert all(source.read_bytes() == expected[key] for source, key, _ in candidates[1:])
    assert packer.run(candidates, target_bytes=4)["convertedFiles"] == 2
    assert {key: packer.packs.read(key) for key in expected} == expected


def test_time_budget_is_shared_with_hot_records(tmp_path, monkeypatch):
    from trading_max import pack_maintenance

    state = initialized_state(tmp_path / "state")
    store = ContentAddressedArtifactStore(state / "artifacts")
    cold = store.put_json(key="source.json", payload={"value": "original"})
    hot = store.put_json(key="current.json", payload={"value": "current"})
    SnapshotStore(state, artifacts=store).publish(
        scope="accounts", source="fixture", artifacts=[hot]
    )
    clock = [0.0]
    monkeypatch.setattr(pack_maintenance.time, "monotonic", lambda: clock[0])
    window = PackWindow(1, progress=lambda _: clock.__setitem__(0, 2))
    result = pack_state(state, tmp_path / "journals", window=window)
    assert result["convertedFiles"] == 1
    assert store.packs.contains("artifact/" + cold.ref.artifact_id)
    assert hot.path.exists()
    assert SnapshotStore(state).latest().manifest.artifacts[0].artifact_id == hot.ref.artifact_id


def test_nightly_batch_drains_more_than_the_old_daily_cap(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    candidates = []
    for i in range(4100):
        path = root / str(i)
        path.write_bytes(str(i).encode())
        candidates.append((path, str(i), "raw"))
    packs = ObjectPacks(tmp_path / "pool")
    packer = LoosePacker(root, packs, tmp_path / "journals")
    result = _nightly_batch(
        tmp_path,
        "fixture",
        lambda **budgets: packer.run(candidates, **budgets),
        lambda: sum(path.exists() for path, _, _ in candidates),
    )
    assert result["convertedFiles"] == 4100
    assert result["remainingFiles"] == 0 and result["limitReason"] is None
    assert all(packs.read(str(i)) == str(i).encode() for i in range(4100))


def test_nightly_batch_reports_remaining_work_when_deployment_is_waiting(tmp_path, monkeypatch):
    from trading_max import background_backup

    monkeypatch.setattr(background_backup, "deployment_requested", lambda _: True)
    root = tmp_path / "source"
    root.mkdir()
    source = root / "original"
    source.write_bytes(b"original")
    packer = LoosePacker(root, ObjectPacks(tmp_path / "pool"), tmp_path / "journals")
    result = _nightly_batch(
        tmp_path,
        "fixture",
        lambda **budgets: packer.run([(source, "original", "raw")], **budgets),
        lambda: int(source.exists()),
    )
    assert result["convertedFiles"] == 0
    assert result["remainingFiles"] == 1
    assert result["limitReason"] == "deployment-request"
    assert source.read_bytes() == b"original"
