from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3

import pytest
from trading_max import physical_recovery, recovery_pack_sharing, sealed_compression
from trading_max.backup_repository import BackupRepository, atomic_json
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore, pack_rewrite
from trading_max.infrastructure.object_packs import ObjectPacks, encode
from trading_max.pack_maintenance import PackWindow, compact_manifests, pack_repository, pack_state
from trading_max.storage_migration import compact_repository


def test_rewrite_preserves_roots_and_recovers_after_interrupted_retirement(tmp_path, monkeypatch):
    pool = ObjectPacks(tmp_path / "pool")
    original = {"live/a": b"one", "garbage/b": b"two"}
    old = pool.add(original)["pack"]
    retire = pack_rewrite._retire

    def interrupted(*args):
        raise InterruptedError("power loss after locator commit")

    monkeypatch.setattr(pack_rewrite, "_retire", interrupted)
    with pytest.raises(InterruptedError):
        pack_rewrite.compact(pool, {"live/a"}, tmp_path / "journal")
    assert pool.path(old).is_file()
    assert pool.read("live/a") == b"one"
    monkeypatch.setattr(pack_rewrite, "_retire", retire)
    pack_rewrite.compact(pool, {"live/a"}, tmp_path / "journal")
    assert not pool.path(old).exists()
    assert not list((tmp_path / "journal").glob("*.json"))
    pool.close()
    pool.index.unlink()
    pool.rebuild()
    assert pool.keys() == ["live/a"]
    assert pool.read("live/a") == b"one"


def test_rewrite_fails_closed_on_corruption_and_missing_roots(tmp_path):
    pool = ObjectPacks(tmp_path / "pool")
    old = pool.add({"live/a": b"one", "garbage/b": b"two"})["pack"]
    with pytest.raises(ValueError, match="absent"):
        pack_rewrite.compact(pool, {"live/missing"}, tmp_path / "journal")
    pool.path(old).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        pack_rewrite.compact(pool, {"live/a"}, tmp_path / "journal")
    assert pool.path(old).exists()


def test_adoption_rejects_conflicting_content_before_publishing(tmp_path):
    pool = ObjectPacks(tmp_path / "pool")
    pool.add({"json/a": b"original"})
    content = encode({"json/a": b"different"})
    source = tmp_path / hashlib.sha256(content).hexdigest()
    source.write_bytes(content)
    with pytest.raises(ValueError, match="conflicts"):
        pack_rewrite.adopt(pool, source, {"json/a"})
    assert pool.read("json/a") == b"original"
    assert not pool.path(source.name).exists()


def _example(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE observations(value INTEGER)")
        db.execute("INSERT INTO observations VALUES (17)")
    store = ContentAddressedArtifactStore(state / "artifacts", storage_mode="chunked")
    item = store.put_json(
        key="synthetic.json",
        payload={"rows": [{"n": n, "text": "synthetic" * 32} for n in range(1000)]},
    )
    run = (
        SnapshotStore(state, artifacts=store)
        .publish(scope="accounts", source="synthetic", artifacts=[item])
        .manifest.run_id
    )
    repo = BackupRepository(tmp_path / "repo")
    old = repo.create(state, artifact_encoding="logical")
    compact_repository(repo)
    pack_repository(repo, tmp_path / "pack-backup")
    pack_state(state, tmp_path / "pack-state")
    new = repo.create(state, artifact_encoding="sealed")
    atomic_json(
        repo.root / physical_recovery.COMPRESSION_POLICY, {"schemaVersion": 1, "enabled": True}
    )
    sealed_compression.compress_repository(repo, tmp_path / "compression")
    compact_manifests(repo)
    return state, store, item.ref.artifact_id, run, repo, [old["id"], new["id"]]


def test_cross_format_sharing_restores_every_date_without_source_and_after_index_loss(tmp_path):
    state, store, artifact, run, repo, dates = _example(tmp_path)
    expected = store.content_bytes(artifact)
    manifests = {date: repo.manifest_bytes(date) for date in dates}
    with pytest.raises(ValueError, match="activation"):
        recovery_pack_sharing.share(repo, tmp_path / "sharing")
    atomic_json(repo.root / recovery_pack_sharing.POLICY, {"schemaVersion": 1, "enabled": True})
    repo.packs.add({"future-format/owned": b"preserve unknown ownership"})
    result = recovery_pack_sharing.share(repo, tmp_path / "sharing")
    assert result["sharedPacks"] > 0
    assert result["unmatchedChunks"] == result["remainingFiles"] == 0
    assert result["chunks"]["retiredFileBytes"] > 0
    assert repo.packs.read("future-format/owned") == b"preserve unknown ownership"
    assert not list(sealed_compression.raw_candidates(repo))
    for source in (state / "artifacts/object-packs/blocks").glob("*.pack"):
        raw = physical_recovery.raw_path(repo, source.stem)
        if raw.exists():
            assert not os.path.samefile(raw, source)
            assert os.path.samefile(raw, repo.packed_store.packs.path(source.stem))
    # A changed daily capture keeps original compressed packs, and deduplicates
    # unchanged files rather than creating another generation of wrappers.
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("INSERT INTO observations VALUES (29)")
    changed = repo.create(state, artifact_encoding="sealed")
    assert changed["writtenBytes"] > 0
    assert repo.create(state, artifact_encoding="sealed")["writtenBytes"] == 0
    dates.append(changed["id"])
    recovery_pack_sharing.share(repo, tmp_path / "sharing")
    shutil.rmtree(state)
    for pool in (repo.packs, repo.packed_store.packs):
        pool.close()
        pool.index.unlink()
        pool.rebuild()
    for i, date in enumerate(dates):
        if date in manifests:
            assert repo.manifest_bytes(date) == manifests[date]
        destination = tmp_path / f"restore-{i}"
        repo.restore(date, destination)
        restored = SnapshotStore(destination)
        assert restored.latest().manifest.run_id == run
        assert restored.artifacts.content_bytes(artifact) == expected
        with sqlite3.connect(destination / "trading_max.db") as db:
            assert len(db.execute("SELECT * FROM observations").fetchall()) == (2 if i == 2 else 1)


def test_budget_yields_without_retiring_roots_and_can_resume(tmp_path):
    _, _, _, _, repo, dates = _example(tmp_path)
    atomic_json(repo.root / recovery_pack_sharing.POLICY, {"schemaVersion": 1, "enabled": True})
    result = recovery_pack_sharing.share(
        repo, tmp_path / "sharing", window=PackWindow(60, should_yield=lambda: True)
    )
    assert result["sharedPacks"] == 0
    assert result["remainingFiles"] == 1
    for date in dates:
        assert repo.verify(date)["snapshotRunId"]
    result = recovery_pack_sharing.share(repo, tmp_path / "sharing")
    assert result["sharedPacks"] > 0 and result["remainingFiles"] == 0


def test_new_structured_recovery_copy_stays_raw_when_policy_is_active(tmp_path):
    state, _, _, _, repo, _ = _example(tmp_path)
    atomic_json(repo.root / recovery_pack_sharing.POLICY, {"schemaVersion": 1, "enabled": True})
    live = ObjectPacks(state / "artifacts/object-packs")
    addition = live.add({"future-format/extra": b"synthetic new content"})
    repo.create(state, artifact_encoding="sealed")
    saved = physical_recovery.raw_path(repo, addition["pack"])
    assert saved.read_bytes() == live.path(addition["pack"]).read_bytes()
    assert not os.path.samefile(saved, live.path(addition["pack"]))
    assert saved not in list(sealed_compression.raw_candidates(repo))
