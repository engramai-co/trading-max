from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from trading_max.backup_repository import BackupRepository, atomic_json
from trading_max.checkpoint_migration import FORMAT, migrate_checkpoint
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.physical_recovery import digest_file, raw_path


def example(tmp_path, *, extra=0):
    repo = BackupRepository(tmp_path / "service/backups/repository")
    checkpoint = repo.root.parent / "emergency-checkpoints/synthetic-checkpoint"
    tree = checkpoint / "state"
    tree.mkdir(parents=True)
    with sqlite3.connect(tree / "trading_max.db") as db:
        db.execute("CREATE TABLE synthetic(value INTEGER)")
        db.execute("INSERT INTO synthetic VALUES (17)")
    store = ContentAddressedArtifactStore(tree / "artifacts", storage_mode="chunked")
    item = store.put_json(key="synthetic.json", payload={"rows": list(range(1000))})
    snap = SnapshotStore(tree, artifacts=store).publish(
        scope="accounts", source="synthetic", artifacts=[item]
    )
    for n in range(extra):
        (tree / f"fixture-{n}.txt").write_text(f"synthetic-{n}")
    metadata = {
        "format": FORMAT,
        "createdAt": "2026-09-01T12:34:56+00:00",
        "sourceState": str(tmp_path / "original-state"),
        "restoreState": str(tree),
        "snapshotRunId": snap.manifest.run_id,
        "files": {
            p.relative_to(tree).as_posix(): {
                "sha256": digest_file(p),
                "size": p.stat().st_size,
                "sqliteBackup": p.suffix == ".db",
            }
            for p in tree.rglob("*")
            if p.is_file()
        },
    }
    atomic_json(checkpoint / "manifest.json", metadata)
    return repo, checkpoint, metadata


def test_import_restores_the_original_view_and_only_retires_when_requested(tmp_path):
    repo, checkpoint, metadata = example(tmp_path)
    original = metadata["files"]
    first = migrate_checkpoint(repo, checkpoint)
    assert first["phase"] == "imported"
    assert (checkpoint / "state").is_dir()
    assert first["createdAt"] == metadata["createdAt"]
    assert first["snapshotRunId"] == metadata["snapshotRunId"]
    result = migrate_checkpoint(repo, checkpoint, retire=True)
    assert result["writtenBytes"] == 0
    assert result["reusedFiles"] == len(original)
    assert result["retiredBytes"] == sum(e["size"] for e in original.values())
    assert not (checkpoint / "state").exists()
    assert not (checkpoint / ".retiring-state").exists()
    assert migrate_checkpoint(repo, checkpoint, retire=True)["alreadyRetired"]
    restored = tmp_path / "restored"
    repo.restore(result["id"], restored)
    assert SnapshotStore(restored).latest().manifest.run_id == metadata["snapshotRunId"]
    with sqlite3.connect(restored / "trading_max.db") as db:
        assert db.execute("SELECT * FROM synthetic").fetchall() == [(17,)]
    for name, entry in original.items():
        assert digest_file(restored / name) == entry["sha256"]
        assert (restored / name).stat().st_ino != raw_path(repo, entry["sha256"]).stat().st_ino


@pytest.mark.parametrize("damage", ["unknown", "missing", "modified", "link", "directory-link"])
def test_damaged_or_unlisted_source_never_retires(tmp_path, damage):
    repo, checkpoint, _ = example(tmp_path)
    tree = checkpoint / "state"
    if damage == "unknown":
        (tree / "unexpected.txt").write_text("keep this")
    elif damage == "missing":
        (tree / "latest.json").unlink()
    elif damage == "modified":
        (tree / "latest.json").write_text("{}")
    elif damage == "link":
        (tree / "latest.json").unlink()
        (tree / "latest.json").symlink_to(tree / "trading_max.db")
    else:
        (tree / "linked-dir").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert tree.exists()
    assert not list(repo.snapshots.iterdir())


@pytest.mark.parametrize("damage", ["format", "path", "state", "snapshot", "naive-date"])
def test_unsupported_or_unsafe_manifest_never_retires(tmp_path, damage):
    repo, checkpoint, metadata = example(tmp_path)
    if damage == "format":
        metadata["format"] = "unknown"
    elif damage == "path":
        metadata["files"]["../outside"] = next(iter(metadata["files"].values()))
    elif damage == "state":
        metadata["sourceState"] = str(checkpoint / "state")
    elif damage == "snapshot":
        metadata["snapshotRunId"] = "wrong"
    else:
        metadata["createdAt"] = "2026-09-01T12:34:56"
    atomic_json(checkpoint / "manifest.json", metadata)
    with pytest.raises(ValueError):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / "state").exists()
    assert not list(repo.snapshots.iterdir())


def test_unmanaged_checkpoint_and_symlink_are_rejected(tmp_path):
    repo, checkpoint, _ = example(tmp_path)
    alias = checkpoint.parent / "alias"
    alias.symlink_to(checkpoint, target_is_directory=True)
    with pytest.raises(ValueError, match="directory"):
        migrate_checkpoint(repo, alias, retire=True)
    outside = tmp_path / "outside"
    shutil.copytree(checkpoint, outside)
    with pytest.raises(ValueError, match="directory"):
        migrate_checkpoint(repo, outside, retire=True)


def test_existing_corrupt_repository_object_blocks_retirement(tmp_path):
    repo, checkpoint, metadata = example(tmp_path)
    first = migrate_checkpoint(repo, checkpoint)
    obj = raw_path(repo, metadata["files"]["trading_max.db"]["sha256"])
    content = bytearray(obj.read_bytes())
    content[-1] ^= 1
    obj.write_bytes(content)
    with pytest.raises(ValueError, match="checksum"):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / "state").exists()
    assert repo.read_manifest(first["id"])


@pytest.mark.parametrize("phase", ["importing-checkpoint", "checkpoint-retirement-ready"])
def test_interruption_preserves_source_and_retry_reuses_completed_work(tmp_path, phase):
    repo, checkpoint, _ = example(tmp_path, extra=140)

    def interrupt(details):
        if details["phase"] == phase:
            raise InterruptedError("synthetic interruption")

    repo.progress = interrupt
    with pytest.raises(InterruptedError):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / "state").exists()
    repo.progress = None
    result = migrate_checkpoint(repo, checkpoint, retire=True)
    assert result["reusedFiles"] >= 128
    assert result["phase"] == "retired"


def test_interrupted_removal_is_reverified_and_resumed(tmp_path, monkeypatch):
    repo, checkpoint, _ = example(tmp_path)
    original = shutil.rmtree

    def interrupt(path, *args, **kwargs):
        if Path(path) == checkpoint / ".retiring-state":
            (Path(path) / "latest.json").unlink()
            raise InterruptedError("partial deletion")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", interrupt)
    with pytest.raises(InterruptedError):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / ".retiring-state").exists()
    monkeypatch.setattr(shutil, "rmtree", original)
    assert migrate_checkpoint(repo, checkpoint)["phase"] == "retiring"
    assert (checkpoint / ".retiring-state").exists()
    result = migrate_checkpoint(repo, checkpoint, retire=True)
    assert result["phase"] == "retired"
    assert not (checkpoint / ".retiring-state").exists()
    assert repo.verify(result["id"])["snapshotRunId"]


def test_change_after_restore_prevents_retirement(tmp_path):
    repo, checkpoint, _ = example(tmp_path)

    def tamper(details):
        if details["phase"] == "checkpoint-retirement-ready":
            (checkpoint / "state/unknown").write_text("do not delete")

    repo.progress = tamper
    with pytest.raises(ValueError, match="changed before retirement"):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / "state/unknown").is_file()
    assert json.loads((checkpoint / "retirement.json").read_bytes())["phase"] == "retiring"


def test_invalid_published_manifest_preserves_original_copy(tmp_path, monkeypatch):
    repo, checkpoint, _ = example(tmp_path)

    def bad_publication(backup_id, manifest):
        atomic_json(repo.manifest_path(backup_id), {**manifest, "files": {}})

    monkeypatch.setattr(repo, "_publish_manifest", bad_publication)
    with pytest.raises(ValueError, match="read-back"):
        migrate_checkpoint(repo, checkpoint, retire=True)
    assert (checkpoint / "state/trading_max.db").is_file()
    assert not (checkpoint / "retirement.json").exists()
