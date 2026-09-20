from __future__ import annotations

import gzip
import json
import sqlite3
import tarfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import pytest
from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.infrastructure import SnapshotStore
from trading_max.infrastructure.artifacts import ArtifactIntegrityError


def state_at(root: Path) -> Path:
    root.mkdir()
    with sqlite3.connect(root / "trading_max.db") as db:
        db.execute("CREATE TABLE example(value TEXT)")
        db.execute("INSERT INTO example VALUES ('synthetic')")
    (root / "secrets").mkdir()
    (root / "secrets/key").write_text("synthetic-secret")
    store = SnapshotStore(root)
    item = store.artifacts.put_json(key="example.json", payload={"value": [1, 2, 3]})
    store.publish(scope="accounts", source="test", artifacts=[item])
    return root


def test_backup_is_independent_deduplicated_and_restorable(tmp_path: Path):
    state = state_at(tmp_path / "state")
    repo = BackupRepository(tmp_path / "backups")
    one = repo.create(state)
    blobs = set(repo.blobs.rglob("*.gz"))
    two = repo.create(state)
    assert set(repo.blobs.rglob("*.gz")) == blobs
    assert one["id"] != two["id"]
    assert one["snapshotRunId"] == two["snapshotRunId"]
    # Source loss or modification cannot change a recovery copy.
    (state / "latest.json").unlink()
    restored = tmp_path / "recovered"
    result = repo.restore(one["id"], restored)
    assert result["snapshotRunId"] == one["snapshotRunId"]
    assert SnapshotStore(restored).latest().manifest.run_id == one["snapshotRunId"]
    assert not (restored / "secrets").exists()
    with sqlite3.connect(restored / "trading_max.db") as db:
        assert db.execute("SELECT * FROM example").fetchall() == [("synthetic",)]


def test_corruption_never_publishes_or_overwrites_state(tmp_path: Path):
    state = state_at(tmp_path / "state")
    repo = BackupRepository(tmp_path / "backups")
    good = repo.create(state)
    before = set(repo.snapshots.iterdir())
    manifest = json.loads(Path(good["manifest"]).read_text())
    entry = manifest["files"]["trading_max.db"]
    repo.blob_path(entry["sha256"]).write_bytes(gzip.compress(b"broken"))
    with pytest.raises(ValueError, match="checksum"):
        repo.create(state)
    assert set(repo.snapshots.iterdir()) == before
    target = tmp_path / "restored"
    with pytest.raises(ValueError):
        repo.restore(good["id"], target)
    assert not target.exists()
    with pytest.raises(FileExistsError):
        repo.restore(good["id"], state)


def test_wal_database_validation_does_not_add_files_to_restored_state(tmp_path: Path):
    state = state_at(tmp_path / "state")
    with closing(sqlite3.connect(state / "trading_max.db")) as database:
        assert database.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
    repository = BackupRepository(tmp_path / "backups")
    backup = repository.create(state)
    manifest = json.loads(Path(backup["manifest"]).read_text())
    restored = tmp_path / "recovered"
    repository.restore(backup["id"], restored)
    assert {
        path.relative_to(restored).as_posix() for path in restored.rglob("*") if path.is_file()
    } == set(manifest["files"])
    expected = gzip.decompress(
        repository.blob_path(manifest["files"]["trading_max.db"]["sha256"]).read_bytes()
    )
    assert (restored / "trading_max.db").read_bytes() == expected


def test_missing_snapshot_reference_fails_closed(tmp_path: Path):
    state = state_at(tmp_path / "state")
    for path in (state / "artifacts/sha256").iterdir():
        path.unlink()
    repo = BackupRepository(tmp_path / "backups")
    with pytest.raises(ValueError, match="missing artifact"):
        repo.create(state)
    assert not list(repo.snapshots.iterdir())


def test_corrupt_source_artifact_is_not_certified_as_a_recovery_copy(tmp_path: Path):
    state = state_at(tmp_path / "state")
    repo = BackupRepository(tmp_path / "backups")
    good = repo.create(state)
    artifact = next((state / "artifacts/sha256").iterdir())
    artifact.write_text('{"already_corrupt":true}')
    with pytest.raises(ArtifactIntegrityError):
        repo.create(state)
    assert [path.stem for path in repo.snapshots.iterdir()] == [good["id"]]
    assert repo.verify(good["id"])["snapshotRunId"] == good["snapshotRunId"]


def test_nested_destination_symlinks_and_concurrent_maintenance_are_rejected(tmp_path: Path):
    state = state_at(tmp_path / "state")
    repo = BackupRepository(tmp_path / "backups")
    with exclusive_lock(repo.lock), pytest.raises(RuntimeError, match="lock"):
        repo.create(state)
    (state / "outside").symlink_to(tmp_path / "backups", target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        repo.create(state)
    (state / "outside").unlink()
    with pytest.raises(ValueError, match="outside state"):
        BackupRepository(state / "backups").create(state)


def test_restore_rejects_path_traversal_and_blob_links(tmp_path: Path):
    state = state_at(tmp_path / "state")
    repo = BackupRepository(tmp_path / "backups")
    good = repo.create(state)
    path = Path(good["manifest"])
    manifest = json.loads(path.read_text())
    manifest["files"]["../outside"] = manifest["files"]["trading_max.db"]
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="unsafe backup path"):
        repo.restore(good["id"], tmp_path / "restore")
    assert not (tmp_path / "outside").exists()
    del manifest["files"]["../outside"]
    path.write_text(json.dumps(manifest))
    blob = repo.blob_path(manifest["files"]["trading_max.db"]["sha256"])
    blob.unlink()
    blob.symlink_to(state / "trading_max.db")
    with pytest.raises(ValueError, match="symlinks"):
        repo.verify(good["id"])


def test_chunked_history_backup_restores_with_default_dual_reader(tmp_path: Path):
    from trading_max.infrastructure import ContentAddressedArtifactStore

    state = state_at(tmp_path / "state")
    writer = ContentAddressedArtifactStore(state / "artifacts", history_mode="chunked")
    payload = {"points": [{"bucket_at": "2026-01-01T12:00:00Z", "value": 123.45}]}
    item = writer.put_json(key="account/nav/valuation_history.json", payload=payload)
    SnapshotStore(state).publish(scope="accounts", source="test", artifacts=[item])
    original = writer.content_bytes(item.ref.artifact_id)
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state)
    recovered = tmp_path / "recovered"
    repo.restore(backup["id"], recovered)
    reader = ContentAddressedArtifactStore(recovered / "artifacts")
    assert reader.get_json(item.ref.artifact_id).payload == payload
    assert reader.content_bytes(item.ref.artifact_id) == original
    assert SnapshotStore(recovered).latest().manifest.run_id == backup["snapshotRunId"]
    # A missing physical dependency fails even if the logical artifact exists.
    block = writer.history.paths(writer.descriptor(item.ref.artifact_id))[0]
    block.unlink()
    with pytest.raises(ValueError, match="missing chunk"):
        repo.create(state)
    assert len(list(repo.snapshots.iterdir())) == 1


def test_archive_import_preserves_date_database_bytes_and_deduplicates(tmp_path: Path):
    state = state_at(tmp_path / "state")
    archive = tmp_path / "trading_max-20260102T043000Z.tar.gz"
    import io

    with tarfile.open(archive, "w:gz") as handle:
        metadata = tarfile.TarInfo("._state")
        metadata.size = 4
        handle.addfile(metadata, io.BytesIO(b"meta"))
        for name in ("trading_max.db", "latest.json", "snapshots", "artifacts"):
            handle.add(state / name, arcname="state/" + name)
    original_database = (state / "trading_max.db").read_bytes()
    repo = BackupRepository(tmp_path / "repository")
    imported = repo.import_archive(archive)
    manifest = json.loads(Path(imported["manifest"]).read_text())
    assert datetime.fromisoformat(manifest["createdAt"]) == datetime(2026, 1, 2, 4, 30, tzinfo=UTC)
    assert manifest["importedAt"] != manifest["createdAt"]
    assert manifest["sourceArchive"]["name"] == archive.name
    assert manifest["sourceArchive"]["rootMetadata"]["name"] == "._state"
    assert manifest["sourceState"] is None  # Not a substitute for a current live-state backup.
    assert archive.exists()
    assert repo.import_archive(archive)["reused"] is True
    assert len(list(repo.snapshots.iterdir())) == 1
    recovered = tmp_path / "recovered"
    repo.restore(imported["id"], recovered)
    assert (recovered / "trading_max.db").read_bytes() == original_database
    assert (recovered / "latest.json").read_bytes() == (state / "latest.json").read_bytes()


@pytest.mark.parametrize("unsafe", ["link", "duplicate", "outside", "secret", "budget"])
def test_archive_import_rejects_unsafe_or_unbounded_members(tmp_path: Path, unsafe: str):
    import io

    archive = tmp_path / "trading_max-20260102T043000Z.tar.gz"
    with tarfile.open(archive, "w:gz") as handle:
        member = tarfile.TarInfo("state/entry")
        member.size = 4
        if unsafe == "link":
            member.type = tarfile.SYMTYPE
            member.linkname = "../../outside"
        elif unsafe == "outside":
            member.name = "state/../outside"
        elif unsafe == "secret":
            member.name = "state/secrets/key"
        handle.addfile(member, io.BytesIO(b"test"))
        if unsafe == "duplicate":
            handle.addfile(member, io.BytesIO(b"test"))
    repo = BackupRepository(tmp_path / "repository")
    with pytest.raises(ValueError):
        repo.import_archive(archive, max_bytes=1 if unsafe == "budget" else 1024)
    assert archive.exists()
    assert list(repo.snapshots.iterdir()) == []


def test_shared_json_and_compressed_cache_restore_without_live_state(tmp_path):
    from trading_max.infrastructure import ContentAddressedArtifactStore

    state = state_at(tmp_path / "state")
    writer = ContentAddressedArtifactStore(state / "artifacts", storage_mode="chunked")
    data = {"rows": [{"n": i, "text": "synthetic" * 30} for i in range(1000)]}
    item = writer.put_json(key="research/test.json", payload=data)
    SnapshotStore(state, artifacts=writer).publish(
        scope="accounts", source="test", artifacts=[item]
    )
    raw = writer.content_bytes(item.ref.artifact_id)
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state)
    recovered = tmp_path / "recovered"
    repo.restore(backup["id"], recovered)
    reader = ContentAddressedArtifactStore(recovered / "artifacts")
    assert reader.content_bytes(item.ref.artifact_id) == raw
    assert reader.get_json(item.ref.artifact_id).payload == data
    block = writer.physical_paths(writer.descriptor(item.ref.artifact_id))[0]
    block.unlink()
    with pytest.raises(ValueError, match="missing chunk"):
        repo.create(state)


def test_packed_backup_retains_original_manifest_hashes_and_byte_exact_restore(tmp_path):
    from trading_max.infrastructure import ContentAddressedArtifactStore
    from trading_max.infrastructure.history_chunks import canonical

    state = state_at(tmp_path / "state")
    writer = ContentAddressedArtifactStore(state / "artifacts")
    item = writer.put_json(
        key="research/fixture.json",
        payload={"rows": [{"n": i, "label": "synthetic" * 20} for i in range(1000)]},
    )
    SnapshotStore(state).publish(scope="accounts", source="fixture", artifacts=[item])
    raw = item.path.read_bytes()
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state)
    manifest_path = Path(backup["manifest"])
    before = manifest_path.read_bytes()
    digest = json.loads(before)["files"]["artifacts/sha256/" + item.ref.artifact_id]["sha256"]
    packed_store = ContentAddressedArtifactStore(repo.root / "packed")
    descriptor = packed_store.json_chunks.encode(raw)
    repo.packed_path(digest).write_bytes(canonical(descriptor))
    repo.blob_path(digest).unlink()
    assert repo.verify(backup["id"])["snapshotRunId"] == backup["snapshotRunId"]
    recovered = tmp_path / "recovered"
    repo.restore(backup["id"], recovered)
    assert (recovered / "artifacts/sha256" / item.ref.artifact_id).read_bytes() == raw
    assert manifest_path.read_bytes() == before
    assert set(packed_store.physical_paths(descriptor)).issubset(repo.blob_files(digest))
    another = repo.create(state)
    assert another["snapshotRunId"] == backup["snapshotRunId"]
    assert not repo.blob_path(digest).exists()
    packed_store.physical_paths(descriptor)[0].unlink()
    with pytest.raises(ValueError):
        repo.verify(backup["id"])
