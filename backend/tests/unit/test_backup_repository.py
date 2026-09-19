from __future__ import annotations

import gzip
import json
import sqlite3
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
