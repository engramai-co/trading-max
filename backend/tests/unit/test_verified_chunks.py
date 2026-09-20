import gzip
import hashlib
import os

import pytest
from trading_max.infrastructure import verified_chunks
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


def test_each_backup_verification_reads_physical_chunks_afresh(tmp_path, monkeypatch):
    import sqlite3

    from trading_max.backup_repository import BackupRepository
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

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
    reads = []
    original = verified_chunks.read_verified

    def counted(path, size, digest):
        reads.append(path)
        return original(path, size, digest)

    monkeypatch.setattr(verified_chunks, "read_verified", counted)
    for _ in range(2):
        reads.clear()
        assert repo.verify(backup["id"])["snapshotRunId"]
        packed_reads = [p for p in reads if p.is_relative_to(repo.root / "packed")]
        assert packed_reads
        assert len(packed_reads) == len(set(packed_reads))
