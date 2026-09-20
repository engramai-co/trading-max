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
    packed_many = ObjectPacks.read_many

    def counted_many(pool, keys, **kwargs):
        if pool.root == repo.packed_store.packs.root:
            pack_reads.extend(key for key in keys if key.startswith(("json/", "history/")))
        return packed_many(pool, keys, **kwargs)

    monkeypatch.setattr(ObjectPacks, "read_many", counted_many)
    for _ in range(2):
        reads.clear()
        pack_reads.clear()
        assert repo.verify(backup["id"])["snapshotRunId"]
        packed_reads = (
            pack_reads if sealed else [p for p in reads if p.is_relative_to(repo.root / "packed")]
        )
        assert packed_reads
        assert len(packed_reads) == len(set(packed_reads))


@pytest.mark.parametrize("batch", [False, True])
def test_packed_cache_is_bounded_and_keeps_claims_and_source_identity(tmp_path, monkeypatch, batch):
    pool = ObjectPacks(tmp_path / "packs")
    items = {f"json/{i}": bytes([i]) * 90 for i in range(4)}
    pool.add(items)
    reads = []
    original = pool.read

    def counted(key):
        reads.append(key)
        return original(key)

    monkeypatch.setattr(pool, "read", counted)
    original_many = pool.read_many

    def counted_many(keys, **kwargs):
        reads.extend(keys)
        return original_many(keys, **kwargs)

    monkeypatch.setattr(pool, "read_many", counted_many)
    cache = VerifiedChunkCache(max_bytes=200, max_entries=2)

    def read(key, size=90):
        digest = hashlib.sha256(items[key]).hexdigest()
        if batch:
            return cache.read_packed_many(pool, [(key, size, digest)])[key]
        return cache.read_packed(pool, key, size, digest)

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


@pytest.mark.parametrize("sealed", [False, True])
def test_logical_backup_capture_reuses_source_chunks_with_a_fresh_cache(
    tmp_path, monkeypatch, sealed
):
    import sqlite3

    from trading_max.backup_repository import BackupRepository
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
    from trading_max.pack_maintenance import pack_state

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
    if sealed:
        while pack_state(state, tmp_path / "journals")["convertedFiles"]:
            pass
    reads = []
    original = verified_chunks.read_verified
    packed_read = ObjectPacks.read

    def counted(path, size, digest):
        if path.is_relative_to(state):
            reads.append(str(path))
        return original(path, size, digest)

    def counted_pack(pool, key):
        if pool.root == store.packs.root and key.startswith(("json/", "history/")):
            reads.append(key)
        return packed_read(pool, key)

    monkeypatch.setattr(verified_chunks, "read_verified", counted)
    monkeypatch.setattr(ObjectPacks, "read", counted_pack)
    packed_many = ObjectPacks.read_many

    def counted_many(pool, keys, **kwargs):
        if pool.root == store.packs.root:
            reads.extend(key for key in keys if key.startswith(("json/", "history/")))
        return packed_many(pool, keys, **kwargs)

    monkeypatch.setattr(ObjectPacks, "read_many", counted_many)
    for index in range(2):
        reads.clear()
        repo = BackupRepository(tmp_path / f"recovery-{index}")
        assert repo.create(state, artifact_encoding="logical")["snapshotRunId"]
        physical_reads = (
            [r for r in reads if r.startswith(("json/", "history/"))] if sealed else reads
        )
        assert physical_reads
        assert len(physical_reads) == len(set(physical_reads))


@pytest.mark.parametrize("family", ["json", "history"])
def test_envelope_batches_cross_pack_chunks_and_keeps_loose_corruption_visible(
    tmp_path, monkeypatch, family
):
    from datetime import UTC, datetime, timedelta

    from trading_max.infrastructure import ArtifactIntegrityError, ContentAddressedArtifactStore

    store = ContentAddressedArtifactStore(
        tmp_path / "artifacts", storage_mode="chunked", history_mode="chunked"
    )
    if family == "json":
        key = "synthetic.json"
        payload = {"rows": [{"n": i, "text": "synthetic" * 32} for i in range(2500)]}
    else:
        key = "account/nav/valuation_history.json"
        payload = {
            "points": [
                {
                    "bucket_at": (datetime(2025, 1, 1, tzinfo=UTC) + timedelta(days=i)).isoformat(),
                    "n": i,
                    "source_artifact_ids": ["synthetic"],
                }
                for i in range(100)
            ]
        }
    ref = store.put_json(key=key, payload=payload).ref
    expected = store.content_bytes(ref.artifact_id)
    descriptor = store.descriptor(ref.artifact_id)
    paths = store.logical_paths(descriptor)
    assert len(paths) > 4
    records = {family + "/" + p.stem: gzip.decompress(p.read_bytes()) for p in paths}
    keys = list(records)
    store.packs.add({key: records[key] for key in keys[::2]})
    store.packs.add({key: records[key] for key in keys[1::2]})
    for path in paths:
        path.unlink()
    store.packs.cache_bytes = 0
    store.packs._cache.clear()
    store.packs._cached_bytes = 0
    loads = []
    original = store.packs._load

    def counted(digest):
        loads.append(digest)
        return original(digest)

    monkeypatch.setattr(store.packs, "_load", counted)
    assert store.content_bytes(ref.artifact_id) == expected
    assert len(loads) == len(set(loads)) == 2
    paths[0].write_bytes(b"corrupt loose alias")
    with pytest.raises(ArtifactIntegrityError):
        store.content_bytes(ref.artifact_id)


def test_batch_budget_rejects_false_size_before_loading_blocks(tmp_path, monkeypatch):
    pool = ObjectPacks(tmp_path / "packs")
    raw = b"synthetic" * 100
    digest = hashlib.sha256(raw).hexdigest()
    key = "json/" + digest
    pool.add({key: raw})
    loads = []
    original = pool._load

    def counted(value):
        loads.append(value)
        return original(value)

    monkeypatch.setattr(pool, "_load", counted)
    with pytest.raises(ValueError, match="byte budget"):
        verified_chunks.read_packable_chunks(
            [(tmp_path / "absent.gz", 1, digest, key)], pool, max_bytes=1
        )
    assert not loads
    assert pool.read_many([key, key], max_bytes=len(raw)) == [raw, raw]
