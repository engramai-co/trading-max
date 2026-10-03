from __future__ import annotations

import gzip
import hashlib
import json
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from trading_max import physical_recovery as physical
from trading_max import recovery_checkpoint as checkpoints
from trading_max.background_backup import pending, run_background
from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.pack_maintenance import pack_state


def example(root, *, packed=False, extra=0):
    root.mkdir()
    with sqlite3.connect(root / "trading_max.db") as db:
        db.execute("CREATE TABLE values_table(value INTEGER)")
        db.execute("INSERT INTO values_table VALUES (17)")
    (root / "secrets").mkdir()
    (root / "secrets/key").write_text("synthetic-excluded")
    store = ContentAddressedArtifactStore(root / "artifacts", storage_mode="chunked")
    item = store.put_json(
        key="test.json", payload={"rows": [{"n": n, "text": "synthetic" * 32} for n in range(1000)]}
    )
    small = store.put_json(key="small.json", payload={"value": 3})
    binary = store.put_bytes(key="source.csv", content=b"synthetic,data\n1,2\n")
    snap = SnapshotStore(root, artifacts=store).publish(
        scope="accounts", source="synthetic", artifacts=[item, small, binary]
    )
    for n in range(extra):
        (root / f"fixture-{n}.txt").write_text(f"synthetic-{n}")
    if packed:
        pack_state(root, root.parent / "pack-journals")
    return snap.manifest.run_id, item.ref.artifact_id


@pytest.mark.parametrize("packed", [False, True])
def test_physical_recovery_survives_source_loss_and_preserves_bytes(tmp_path, packed):
    state = tmp_path / "state"
    run_id, artifact_id = example(state, packed=packed)
    raw = SnapshotStore(state).artifacts.content_bytes(artifact_id)
    repo = BackupRepository(tmp_path / "repository")
    result = repo.create(state, artifact_encoding="sealed")
    manifest = repo.read_manifest(result["id"])
    assert manifest["artifactEncoding"] == "sealed"
    assert result["snapshotRunId"] == run_id
    assert result["archiveStatus"] == "verified"
    assert not any("secrets" in name for name in manifest["files"])
    assert not pending(repo)
    second = repo.create(state, artifact_encoding="sealed")
    assert second["writtenBytes"] == 0
    assert second["reusedFiles"] == second["files"]
    shutil.rmtree(state)
    restored = tmp_path / "restored"
    repo.restore(result["id"], restored)
    assert SnapshotStore(restored).artifacts.content_bytes(artifact_id) == raw
    assert SnapshotStore(restored).latest().manifest.run_id == run_id
    with sqlite3.connect(restored / "trading_max.db") as db:
        assert db.execute("SELECT * FROM values_table").fetchall() == [(17,)]
    assert not (restored / "secrets").exists()
    assert all(
        (restored / name).stat().st_ino != physical.raw_path(repo, item["sha256"]).stat().st_ino
        for name, item in manifest["files"].items()
    )
    with pytest.raises(FileExistsError):
        repo.restore(result["id"], restored)


@pytest.mark.parametrize("representation", ["gzip", "pack"])
def test_sealed_recovery_reads_compressed_pool_without_recreating_raw_files(
    tmp_path, representation
):
    state = tmp_path / "state"
    run_id, artifact_id = example(state, packed=True)
    expected = SnapshotStore(state).artifacts.content_bytes(artifact_id)
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state, artifact_encoding="sealed")
    originals = list((repo.root / "physical").glob("*/*"))
    for path in originals:
        raw = path.read_bytes()
        if representation == "gzip":
            target = repo.blob_path(path.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(gzip.compress(raw, mtime=0))
        else:
            repo.packs.add({"blob/" + path.name: raw})
        path.unlink()
    if representation == "pack":
        repo.packs.close()
        repo.packs.index.unlink()
        repo.packs.rebuild()
    (repo.root / physical.COMPRESSION_POLICY).write_text(
        json.dumps({"schemaVersion": 1, "enabled": True})
    )
    assert repo.verify(backup["id"])["snapshotRunId"] == run_id
    again = repo.create(state, artifact_encoding="sealed")
    assert again["writtenBytes"] == 0
    assert not list((repo.root / "physical").glob("*/*"))
    shutil.rmtree(state)
    repo.restore(backup["id"], tmp_path / "restored")
    restored = SnapshotStore(tmp_path / "restored")
    assert restored.latest().manifest.run_id == run_id
    assert restored.artifacts.content_bytes(artifact_id) == expected


@pytest.mark.parametrize("problem", ["digest", "size", "raw-corrupt"])
def test_compressed_recovery_fails_closed(tmp_path, problem):
    repo = BackupRepository(tmp_path / "repository")
    raw = b"synthetic bytes"
    digest = hashlib.sha256(raw).hexdigest()
    path = repo.blob_path(digest)
    path.parent.mkdir(parents=True)
    path.write_bytes(gzip.compress(raw if problem != "digest" else b"corrupt content"))
    if problem == "raw-corrupt":
        alias = physical.raw_path(repo, digest)
        alias.parent.mkdir(parents=True)
        alias.write_bytes(b"corrupt bytes!")
    files = {"synthetic.txt": {"sha256": digest, "size": 1 if problem == "size" else len(raw)}}
    with pytest.raises(ValueError, match=r"size|checksum"):
        physical.verify_objects(repo, files, tmp_path / "restored")


def test_sealed_reader_probe_covers_reuse_restore_and_index_rebuild():
    from trading_max.storage_compatibility import _SEALED_PROBE

    exec(_SEALED_PROBE, {})  # noqa: S102 - fixed synthetic compatibility probe


def test_session_reuses_only_unchanged_verified_sources_and_explicit_verify_is_fresh(
    tmp_path, monkeypatch
):
    from trading_max.recovery_verification import VerificationSession

    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    repo.verification_session = VerificationSession()
    backup = repo.create(state, artifact_encoding="sealed")
    manifest = repo.read_manifest(backup["id"])
    original = repo._verify_full
    calls = []

    def verify(*args):
        calls.append(True)
        return original(*args)

    monkeypatch.setattr(repo, "_verify_full", verify)
    repo._verify(manifest)
    repo._verify(manifest)
    assert not calls
    repo.verify(backup["id"])
    repo.restore(backup["id"], tmp_path / "restored")
    assert len(calls) == 2
    repo.verification_session = VerificationSession()  # New run cannot reuse disk status.
    repo._verify(manifest)
    assert len(calls) == 3
    entry = manifest["files"]["latest.json"]
    path = physical.raw_path(repo, entry["sha256"])
    path.write_bytes(b"x" * path.stat().st_size)
    with pytest.raises(ValueError, match="checksum"):
        repo._verify(manifest)
    assert len(calls) == 4


def test_session_rejects_source_changed_during_full_verification(tmp_path, monkeypatch):
    from trading_max.recovery_verification import VerificationSession

    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    backup = repo.create(state, artifact_encoding="sealed")
    manifest = repo.read_manifest(backup["id"])
    repo.verification_session = VerificationSession()
    original = repo._verify_full

    def verify(*args):
        result = original(*args)
        path = physical.raw_path(repo, manifest["files"]["latest.json"]["sha256"])
        path.write_bytes(path.read_bytes())
        return result

    monkeypatch.setattr(repo, "_verify_full", verify)
    with pytest.raises(ValueError, match="changed during verification"):
        repo._verify(manifest)
    assert not repo.verification_session.proofs


def test_session_detects_compressed_locator_changes(tmp_path):
    from trading_max.recovery_verification import VerificationSession

    repo = BackupRepository(tmp_path / "repository")
    raw = b"synthetic recovery bytes"
    digest = hashlib.sha256(raw).hexdigest()
    repo.packs.add({"blob/" + digest: raw})
    files = {"fixture": {"sha256": digest}}
    before = VerificationSession.fingerprint(repo, files)
    with sqlite3.connect(repo.packs.index) as db:
        db.execute("PRAGMA user_version=2")
    assert VerificationSession.fingerprint(repo, files) != before


def test_background_maintenance_progress_and_interrupted_retry_do_not_capture_again(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    service = tmp_path / "service"
    service.mkdir()

    def interrupted(_):
        with exclusive_lock(service / ".deployment.lock"):
            repo._progress("synthetic-maintenance")
            current = json.loads((repo.root / "background-status.json").read_bytes())
            assert current["progress"]["phase"] == "synthetic-maintenance"
            assert current["seconds"] < 60
            raise InterruptedError("synthetic yield")

    first = run_background(repo, state, service=service, maintain=interrupted)
    assert first["status"] == "deferred"
    assert first["maintenancePending"]
    second = run_background(repo, state, service=service, maintain=lambda _: {"complete": True})
    assert second["status"] == "succeeded"
    assert not second["maintenancePending"]
    assert first["lastBackupId"] == second["lastBackupId"]


def test_resumes_after_interruption_without_recopying_completed_files(tmp_path, monkeypatch):
    state = tmp_path / "state"
    example(state, extra=260)
    repo = BackupRepository(tmp_path / "repository")
    captured = checkpoints.checkpoint(repo, state)

    def stop(details):
        if details["phase"] == "archiving-physical":
            raise InterruptedError("synthetic interruption")

    repo.progress = stop
    with pytest.raises(InterruptedError):
        physical.archive_checkpoint(repo, captured["id"])
    completed = list((repo.root / "physical").glob("*/*"))
    identities = {p.name: p.stat().st_ino for p in completed}
    assert len(completed) >= 128
    assert not list(repo.snapshots.iterdir())
    assert pending(repo) == [captured["id"]]
    repo.progress = None
    result = physical.archive_checkpoint(repo, captured["id"])
    assert result["reusedFiles"] >= 128
    assert all(
        physical.raw_path(repo, key).stat().st_ino == inode for key, inode in identities.items()
    )
    assert not pending(repo)
    assert physical.archive_checkpoint(repo, captured["id"]) == result


def test_reference_validation_yields_without_publishing_an_incomplete_backup(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    captured = checkpoints.checkpoint(repo, state)

    def stop(details):
        if details["phase"] == "verifying-descriptor-references":
            assert details["descriptors"] <= details["totalDescriptors"]
            raise InterruptedError("yield during shared-reference validation")

    repo.progress = stop
    with pytest.raises(InterruptedError, match="shared-reference"):
        physical.archive_checkpoint(repo, captured["id"])
    assert pending(repo) == [captured["id"]]
    assert not list(repo.snapshots.iterdir())
    repo.progress = None
    result = physical.archive_checkpoint(repo, captured["id"])
    assert result["archiveStatus"] == "verified"
    assert result["reusedFiles"] == result["files"]


def test_reused_object_corruption_fails_closed_and_preserves_previous_recovery(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    first = repo.create(state, artifact_encoding="sealed")
    manifest = repo.read_manifest(first["id"])
    item = manifest["files"]["trading_max.db"]
    blob = physical.raw_path(repo, item["sha256"])
    content = bytearray(blob.read_bytes())
    content[-1] ^= 1
    blob.write_bytes(content)
    before = set(repo.snapshots.iterdir())
    with pytest.raises(ValueError, match="checksum"):
        repo.create(state, artifact_encoding="sealed")
    assert set(repo.snapshots.iterdir()) == before
    with pytest.raises(ValueError, match="checksum"):
        repo.restore(first["id"], tmp_path / "recovered")
    assert not (tmp_path / "recovered").exists()
    assert (state / "trading_max.db").exists()


def test_checkpoint_detects_tampering_before_resume(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    captured = checkpoints.checkpoint(repo, state)
    tree = Path(captured["checkpoint"]).parent / "state"
    (tree / "latest.json").write_text("{}")
    with pytest.raises(ValueError, match="changed before archival"):
        physical.archive_checkpoint(repo, captured["id"])
    assert not list(repo.snapshots.iterdir())


def test_online_checkpoint_includes_uncheckpointed_wal_and_pins_pointer(tmp_path, monkeypatch):
    state = tmp_path / "state"
    old_run, _ = example(state)
    original = checkpoints.copy_independent
    published = False

    def publish_during_copy(source, target):
        nonlocal published
        original(source, target)
        if not published:
            published = True
            store = SnapshotStore(state)
            item = store.artifacts.put_json(key="after.json", payload={"new": True})
            store.publish(scope="accounts", source="synthetic", artifacts=[item])

    monkeypatch.setattr(checkpoints, "copy_independent", publish_during_copy)
    with closing(sqlite3.connect(state / "trading_max.db")) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO values_table VALUES (29)")
        writer.commit()
        repo = BackupRepository(tmp_path / "repository")
        captured = checkpoints.checkpoint(repo, state)
        assert captured["snapshotRunId"] == old_run
        result = physical.archive_checkpoint(repo, captured["id"])
    restored = tmp_path / "recovered"
    repo.restore(result["id"], restored)
    with sqlite3.connect(restored / "trading_max.db") as db:
        assert db.execute("SELECT * FROM values_table").fetchall() == [(17,), (29,)]
    assert SnapshotStore(restored).latest().manifest.run_id == old_run


def test_missing_historical_dependency_prevents_publication(tmp_path):
    state = tmp_path / "state"
    _, old_id = example(state)
    store = SnapshotStore(state)
    item = store.artifacts.put_json(key="new.json", payload={"new": True})
    store.publish(scope="accounts", source="synthetic", artifacts=[item])
    store.artifacts.path_for(old_id).unlink()
    repo = BackupRepository(tmp_path / "repository")
    with pytest.raises(ValueError, match="missing artifact"):
        repo.create(state, artifact_encoding="sealed")
    assert not list(repo.snapshots.iterdir())


def test_background_status_resume_and_idle_are_distinct(tmp_path):
    state = tmp_path / "state"
    example(state, extra=140)
    repo = BackupRepository(tmp_path / "repository")
    captured = checkpoints.checkpoint(repo, state)

    def stop(details):
        if details["phase"] == "archiving-physical":
            raise TimeoutError("synthetic time budget")

    repo.progress = stop
    first = run_background(repo, state)
    assert first["status"] == "deferred"
    assert "lastSuccessAt" not in first
    repo.progress = None
    second = run_background(repo, state)
    assert second["status"] == "succeeded"
    assert second["lastBackupId"] == captured["id"]
    assert second["lastBackup"]["reusedFiles"] >= 128
    third = run_background(repo, state)
    assert third["status"] == "idle"
    assert len(list(repo.snapshots.iterdir())) == 1
    assert json.loads((repo.root / "background-status.json").read_bytes())["status"] == "succeeded"


def test_background_yields_to_deployment_without_discarding_recovery(tmp_path):
    state = tmp_path / "state"
    example(state)
    service = tmp_path / "service"
    service.mkdir()
    repo = BackupRepository(service / "backups/repository")
    captured = checkpoints.checkpoint(repo, state)
    with exclusive_lock(service / ".deployment.lock"):
        result = run_background(repo, state, service=service)
    assert result["status"] == "deferred"
    assert pending(repo) == [captured["id"]]
    assert run_background(repo, state, service=service)["status"] == "succeeded"


def test_maintenance_failure_does_not_hide_successful_recovery(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")

    def fail(_):
        raise RuntimeError("synthetic maintenance error")

    result = run_background(repo, state, maintain=fail)
    assert result["status"] == "succeeded"
    assert "synthetic maintenance error" in result["maintenanceError"]
    assert repo.verify(result["lastBackupId"])["snapshotRunId"]


def test_symlinks_are_not_captured_or_followed(tmp_path):
    state = tmp_path / "state"
    example(state)
    (state / "link").symlink_to(state / "trading_max.db")
    repo = BackupRepository(tmp_path / "repository")
    with pytest.raises(ValueError, match="symlink"):
        checkpoints.checkpoint(repo, state)
    assert not pending(repo)


def test_old_logical_recovery_remains_readable_alongside_sealed_points(tmp_path):
    state = tmp_path / "state"
    run_id, _ = example(state)
    repo = BackupRepository(tmp_path / "repository")
    legacy = repo.create(state, artifact_encoding="logical")
    repo.create(state, artifact_encoding="sealed")
    shutil.rmtree(state)
    assert repo.restore(legacy["id"], tmp_path / "legacy")["snapshotRunId"] == run_id


def test_resume_journal_cannot_substitute_another_valid_object(tmp_path):
    state = tmp_path / "state"
    example(state)
    (state / "first.txt").write_text("aaaa")
    (state / "second.txt").write_text("bbbb")
    repo = BackupRepository(tmp_path / "repository")
    one = repo.create(state, artifact_encoding="sealed")
    manifest = repo.read_manifest(one["id"])
    with sqlite3.connect(repo.root / "physical-journal.sqlite3") as db:
        db.execute(
            "UPDATE files SET digest=? WHERE path=?",
            (manifest["files"]["second.txt"]["sha256"], str(state / "first.txt")),
        )
    with pytest.raises(ValueError, match="journal does not match"):
        repo.create(state, artifact_encoding="sealed")
    assert len(list(repo.snapshots.iterdir())) == 1


def test_checkpoint_captures_secondary_sqlite_wal(tmp_path):
    state = tmp_path / "state"
    example(state)
    with closing(sqlite3.connect(state / "secondary.sqlite3")) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE data(value TEXT)")
        writer.execute("INSERT INTO data VALUES ('synthetic')")
        writer.commit()
        repo = BackupRepository(tmp_path / "repository")
        result = repo.create(state, artifact_encoding="sealed")
    restored = tmp_path / "restored"
    repo.restore(result["id"], restored)
    with sqlite3.connect(restored / "secondary.sqlite3") as db:
        assert db.execute("SELECT * FROM data").fetchall() == [("synthetic",)]
    assert not list(restored.glob("*-wal"))


def test_requested_deployment_interrupts_running_archival_and_next_run_resumes(tmp_path):
    import os

    state = tmp_path / "state"
    example(state, extra=140)
    service = tmp_path / "service"
    service.mkdir()
    repo = BackupRepository(service / "backups/repository")
    capture = checkpoints.checkpoint(repo, state)
    request = service / ".deployment-request-test.json"

    def request_deploy(details):
        if details["phase"] == "archiving-physical":
            request.write_text(json.dumps({"pid": os.getpid()}))

    repo.progress = request_deploy
    result = run_background(repo, state, service=service)
    assert result["status"] == "deferred"
    assert not repo.manifest_path(capture["id"]).exists()
    request.unlink()
    repo.progress = None
    assert run_background(repo, state, service=service)["status"] == "succeeded"


def test_failed_maintenance_retries_without_another_backup(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")

    def fail(_):
        raise RuntimeError("retry maintenance")

    first = run_background(repo, state, maintain=fail)
    second = run_background(repo, state, maintain=lambda _: {"complete": True})
    assert second["status"] == "succeeded"
    assert second["lastBackupId"] == first["lastBackupId"]
    assert second["maintenanceError"] is None
    assert len(list(repo.snapshots.iterdir())) == 1


def test_interruption_during_copy_leaves_no_partial_authoritative_object(tmp_path, monkeypatch):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    captured = checkpoints.checkpoint(repo, state)
    original = physical.copy_independent

    def interrupted(source, target):
        original(source, target)
        raise InterruptedError("interrupted before publication")

    monkeypatch.setattr(physical, "copy_independent", interrupted)
    with pytest.raises(InterruptedError):
        physical.archive_checkpoint(repo, captured["id"])
    assert not list((repo.root / "physical").glob("*/*"))
    assert not list(repo.snapshots.iterdir())
    monkeypatch.setattr(physical, "copy_independent", original)
    assert physical.archive_checkpoint(repo, captured["id"])["snapshotRunId"]


def test_restart_removes_only_owned_unpublished_checkpoint_staging(tmp_path):
    state = tmp_path / "state"
    example(state)
    repo = BackupRepository(tmp_path / "repository")
    parent = repo.root / "checkpoints"
    abandoned = parent / ".capture-owned"
    abandoned.mkdir(parents=True)
    (abandoned / "capture.json").write_text(
        json.dumps({"format": checkpoints.FORMAT, "phase": "capturing"})
    )
    (abandoned / "partial").write_text("synthetic incomplete copy")
    unknown = parent / ".capture-unknown"
    unknown.mkdir()
    (unknown / "keep").write_text("unrecognized file")
    checkpoints.checkpoint(repo, state)
    assert not abandoned.exists()
    assert (unknown / "keep").exists()
