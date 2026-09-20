import gzip
import hashlib
import os

import pytest
from trading_max.infrastructure import verified_chunks
from trading_max.infrastructure.object_packs import ObjectPacks
from trading_max.infrastructure.verified_chunks import VerifiedChunkCache


def test_cache_reuses_verified_bytes_and_bounds_memory_and_entries(tmp_path, monkeypatch):
    reads = []
    original = verified_chunks.read_verified

    def counted(path, size, digest):
        reads.append(path)
        return original(path, size, digest)

    monkeypatch.setattr(verified_chunks, "read_verified", counted)
    cache = VerifiedChunkCache(max_bytes=200, max_entries=2)
    items = []
    for index in range(4):
        raw = bytes([index]) * 90
        path = tmp_path / str(index)
        path.write_bytes(gzip.compress(raw))
        items.append((path, len(raw), hashlib.sha256(raw).hexdigest()))
    assert cache.read(*items[0]) == cache.read(*items[0])
    assert len(reads) == 1
    for item in items[1:]:
        cache.read(*item)
        assert cache.bytes <= 200 and len(cache.entries) <= 2
    cache.read(*items[0])
    assert reads.count(items[0][0]) == 2


def test_changed_corrupt_source_invalidates_cache_even_with_preserved_mtime(tmp_path):
    raw = b"synthetic record" * 20
    path = tmp_path / "chunk.gz"
    path.write_bytes(gzip.compress(raw))
    args = (path, len(raw), hashlib.sha256(raw).hexdigest())
    cache = VerifiedChunkCache()
    assert cache.read(*args) == raw
    before = path.stat()
    damaged = bytearray(path.read_bytes())
    damaged[-8] ^= 1
    path.write_bytes(damaged)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(ValueError, match=r"decompressed|checksum"):
        cache.read(*args)


def test_equal_digests_at_different_locations_do_not_share_trust(tmp_path):
    raw = b"synthetic"
    live = tmp_path / "live.gz"
    backup = tmp_path / "backup.gz"
    live.write_bytes(gzip.compress(raw))
    backup.write_bytes(b"corrupt")
    cache = VerifiedChunkCache()
    digest = hashlib.sha256(raw).hexdigest()
    cache.read(live, len(raw), digest)
    with pytest.raises(ValueError):
        cache.read(backup, len(raw), digest)


@pytest.mark.parametrize("sealed", [False, True])
def test_each_backup_verification_reads_physical_chunks_afresh(tmp_path, monkeypatch, sealed):
    import sqlite3

    from trading_max.backup_repository import BackupRepository
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
    from trading_max.pack_maintenance import pack_repository

    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE observations(value INTEGER)")
    store = ContentAddressedArtifactStore(state / "artifacts", storage_mode="chunked")
    series = [{"n": i, "text": "synthetic" * 80} for i in range(512)]
    items = [
        store.put_json(key=f"synthetic-{i}.json", payload={"series": series}) for i in range(4)
    ]
    SnapshotStore(state, artifacts=store).publish(scope="accounts", source="test", artifacts=items)
    repo = BackupRepository(tmp_path / "recovery")
    backup = repo.create(state, artifact_encoding="logical")
    if sealed:
        while pack_repository(repo, tmp_path / "journals")["convertedFiles"]:
            pass
    reads = []
    original = verified_chunks.read_verified

    def counted(path, size, digest):
        reads.append(path)
        return original(path, size, digest)

    monkeypatch.setattr(verified_chunks, "read_verified", counted)
    pack_reads = []
    packed_read = ObjectPacks.read

    def counted_pack(pool, key):
        if pool.root == repo.packed_store.packs.root and key.startswith(("json/", "history/")):
            pack_reads.append(key)
        return packed_read(pool, key)

    monkeypatch.setattr(ObjectPacks, "read", counted_pack)
    for _ in range(2):
        reads.clear()
        pack_reads.clear()
        assert repo.verify(backup["id"])["snapshotRunId"]
        packed_reads = (
            pack_reads if sealed else [p for p in reads if p.is_relative_to(repo.root / "packed")]
        )
        assert packed_reads
        assert len(packed_reads) == len(set(packed_reads))


def test_packed_cache_is_bounded_and_keeps_claims_and_source_identity(tmp_path, monkeypatch):
    pool = ObjectPacks(tmp_path / "packs")
    items = {f"json/{i}": bytes([i]) * 90 for i in range(4)}
    pool.add(items)
    reads = []
    original = pool.read

    def counted(key):
        reads.append(key)
        return original(key)

    monkeypatch.setattr(pool, "read", counted)
    cache = VerifiedChunkCache(max_bytes=200, max_entries=2)

    def read(key, size=90):
        return cache.read_packed(pool, key, size, hashlib.sha256(items[key]).hexdigest())

    assert read("json/0") == read("json/0") == items["json/0"]
    assert reads == ["json/0"]
    with pytest.raises(ValueError, match="checksum"):
        read("json/0", size=91)
    for key in list(items)[1:]:
        assert read(key) == items[key]
        assert cache.bytes <= 200 and len(cache.entries) <= 2
    read("json/0")
    assert reads.count("json/0") == 3  # Original read, bad size claim, then eviction.

    source = pool.source("json/0")
    before = source.stat()
    damaged = bytearray(source.read_bytes())
    damaged[-1] ^= 1
    source.write_bytes(damaged)
    os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(ValueError):
        read("json/0")
