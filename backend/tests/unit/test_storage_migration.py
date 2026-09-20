import json
import sqlite3

import pytest
from trading_max.backup_repository import BackupRepository
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.storage_migration import StateCompactor, compact_repository


def fixture(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE synthetic(value INTEGER)")
    store = ContentAddressedArtifactStore(state / "artifacts")
    data = {
        "points": [
            {
                "bucket_at": f"2026-01-{i % 28 + 1:02}T00:00:00Z",
                "value": i,
                "source_artifact_ids": ["synthetic" * 8],
            }
            for i in range(1300)
        ]
    }
    a = store.put_json(key="account/nav/valuation_history.json", payload=data)
    b = store.put_json(
        key="research/synthetic.json",
        payload={"rows": [{"n": i, "text": "合成" * 200} for i in range(1000)]},
    )
    SnapshotStore(state).publish(scope="accounts", source="fixture", artifacts=[a, b])
    return state, store, [a, b]


def test_bounded_compaction_preserves_all_logical_bytes_and_snapshot(tmp_path):
    state, _store, items = fixture(tmp_path)
    original = {item.ref.artifact_id: item.path.read_bytes() for item in items}
    latest = SnapshotStore(state).latest().manifest
    compactor = StateCompactor(state, tmp_path / "journals")
    first = compactor.run(max_files=1)
    assert first["convertedFiles"] == 1
    compactor.run()
    assert SnapshotStore(state).latest().manifest == latest
    for artifact_id, raw in original.items():
        assert _store.content_bytes(artifact_id) == raw
    assert compactor.run()["convertedFiles"] == 0


def test_interruption_after_atomic_swap_resumes_from_prepared_journal(tmp_path, monkeypatch):
    state, _store, _items = fixture(tmp_path)
    compactor = StateCompactor(state, tmp_path / "journals")
    original = compactor.logical

    def interrupted(*args):
        raise KeyboardInterrupt("synthetic process interruption")

    monkeypatch.setattr(compactor, "logical", interrupted)
    with pytest.raises(KeyboardInterrupt):
        compactor.run(max_files=1)
    monkeypatch.setattr(compactor, "logical", original)
    compactor.run()
    assert all(
        json.loads(p.read_text())["status"] == "complete"
        for p in (tmp_path / "journals").glob("state-*.json")
    )
    assert SnapshotStore(state).latest()


def test_invalid_identity_is_preserved_and_symlink_not_followed(tmp_path):
    state, _store, items = fixture(tmp_path)
    item = items[0]
    bad = item.path.read_bytes().replace(b'"value":0', b'"value":9', 1)
    item.path.write_bytes(bad)
    with pytest.raises(ValueError, match="identity"):
        StateCompactor(state, tmp_path / "journals").run()
    assert item.path.read_bytes() == bad


def test_recovery_blob_compaction_preserves_manifest_and_exact_file_bytes(tmp_path):
    state, _store, items = fixture(tmp_path)
    repo = BackupRepository(tmp_path / "backups")
    backup = repo.create(state)
    manifest = repo.manifest_path(backup["id"]).read_bytes()
    raw = {item.ref.artifact_id: item.path.read_bytes() for item in items}
    assert compact_repository(repo, max_files=1)["convertedFiles"] == 1
    compact_repository(repo)
    assert repo.manifest_path(backup["id"]).read_bytes() == manifest
    repo.restore(backup["id"], tmp_path / "restored")
    for aid, content in raw.items():
        assert (tmp_path / "restored/artifacts/sha256" / aid).read_bytes() == content
    assert compact_repository(repo)["convertedFiles"] == 0


def test_array_grouping_avoids_one_small_file_per_observation(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="chunked")
    item = store.put_json(
        key="research/synthetic.json",
        payload={"rows": [{"n": i, "text": "synthetic" + str(i) * 250} for i in range(1024)]},
    )
    descriptor = store.descriptor(item.ref.artifact_id)
    assert len(store.physical_paths(descriptor)) < 150


def test_failed_post_swap_read_restores_original_and_can_retry(tmp_path, monkeypatch):
    state, _store, items = fixture(tmp_path)
    originals = {item.path: item.path.read_bytes() for item in items}
    compactor = StateCompactor(state, tmp_path / "journals")
    reader = compactor.logical

    def fail(*args):
        raise ValueError("synthetic verification error")

    monkeypatch.setattr(compactor, "logical", fail)
    with pytest.raises(ValueError, match="verification"):
        compactor.run()
    assert all(path.read_bytes() == raw for path, raw in originals.items())
    monkeypatch.setattr(compactor, "logical", reader)
    compactor.run()
    assert SnapshotStore(state).latest()


def test_failed_packed_validation_does_not_shadow_valid_backup(tmp_path, monkeypatch):
    state, _store, _items = fixture(tmp_path)
    repo = BackupRepository(tmp_path / "backups")
    backup = repo.create(state)
    reader = repo.open_blob

    def fail(*args):
        raise ValueError("synthetic verification error")

    monkeypatch.setattr(repo, "open_blob", fail)
    with pytest.raises(ValueError, match="verification"):
        compact_repository(repo)
    assert not list((repo.root / "packed").glob("*.json"))
    monkeypatch.setattr(repo, "open_blob", reader)
    assert repo.verify(backup["id"])["snapshotRunId"]


def test_runtime_gate_requires_three_successful_recovery_probes(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from trading_max import storage_compatibility as gate

    context = {
        "protected": [str(tmp_path / "current"), str(tmp_path / "old-one")],
        "fingerprint": "synthetic",
    }
    monkeypatch.setattr(
        gate, "ServiceRetention", lambda _: SimpleNamespace(_context=lambda: context)
    )
    with pytest.raises(ValueError, match="two retained"):
        gate.verify_retained_readers(tmp_path)
    context["protected"].append(str(tmp_path / "old-two"))
    calls = []

    def run(arguments, **kwargs):
        calls.append(arguments[0])
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"version": "1.5.7", "verified": True})
        )

    monkeypatch.setattr(gate.subprocess, "run", run)
    assert len(gate.verify_retained_readers(tmp_path)["readers"]) == 3
    assert len(calls) == 3
    monkeypatch.setattr(
        gate.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="")
    )
    with pytest.raises(ValueError, match="cannot recover"):
        gate.verify_retained_readers(tmp_path)
