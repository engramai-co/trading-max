import gzip
import hashlib

import pytest
from trading_max.infrastructure import ArtifactIntegrityError, ContentAddressedArtifactStore
from trading_max.infrastructure import compressed_json as codec


def test_reader_preserves_envelope_identity_original_download_and_logical_size(tmp_path):
    legacy = ContentAddressedArtifactStore(tmp_path / "legacy")
    item = legacy.put_json(key="research/synthetic.json", payload={"text": "合成-data" * 2000})
    raw = item.path.read_bytes()
    item.path.write_bytes(codec.encode(raw))
    assert item.path.stat().st_size < len(raw) / 10
    reader = ContentAddressedArtifactStore(legacy.root)
    assert reader.get_json(item.ref.artifact_id).ref == item.ref
    assert reader.get_json(item.ref.artifact_id).payload == item.payload
    assert reader.content_bytes(item.ref.artifact_id) == raw
    assert reader.logical_size(item.ref.artifact_id) == len(raw)
    assert reader.put_json(key=item.ref.key, payload=item.payload).ref == item.ref
    writer = ContentAddressedArtifactStore(tmp_path / "compressed", storage_mode="compressed")
    other = writer.put_json(key=item.ref.key, payload=item.payload)
    assert other.ref.artifact_id == item.ref.artifact_id
    assert other.path.read_bytes().startswith(codec.MAGIC)
    assert writer.get_json(other.ref.artifact_id).payload == item.payload


def test_binary_prefix_is_not_interpreted_as_storage_format(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="compressed")
    raw = codec.MAGIC + b"binary synthetic file"
    item = store.put_bytes(key="test.dat", content=raw)
    assert store.content_bytes(item.ref.artifact_id) == raw
    assert store.logical_size(item.ref.artifact_id) == len(raw)
    assert store.get_bytes(item.ref.artifact_id).ref == item.ref


def test_compression_does_not_hide_history_dependencies(tmp_path):
    store = ContentAddressedArtifactStore(
        tmp_path, history_mode="chunked", storage_mode="compressed"
    )
    item = store.put_json(
        key="account/nav/valuation_history.json",
        payload={
            "points": [
                {
                    "bucket_at": "2026-01-02T00:00:00Z",
                    "value": 1,
                    "source_artifact_ids": ["synthetic"],
                }
            ]
        },
    )
    assert store.descriptor(item.ref.artifact_id)["chunks"]
    assert store.get_json(item.ref.artifact_id).payload == item.payload


@pytest.mark.parametrize(
    "damage", ["truncated", "body", "digest", "oversize", "length", "trailing"]
)
def test_corruption_and_expansion_limits_fail_closed(tmp_path, damage):
    raw = b"x" * 10000
    encoded = bytearray(codec.encode(raw))
    if damage == "truncated":
        encoded = encoded[:10]
    elif damage == "body":
        encoded[codec.HEADER_BYTES + 12] ^= 255
    elif damage == "digest":
        encoded[len(codec.MAGIC) + 8] ^= 255
    elif damage == "oversize":
        encoded[len(codec.MAGIC) : len(codec.MAGIC) + 8] = (codec.MAX_BYTES + 1).to_bytes(8, "big")
    elif damage == "length":
        encoded[len(codec.MAGIC) : len(codec.MAGIC) + 8] = (10).to_bytes(8, "big")
    else:
        encoded.extend(gzip.compress(b"additional output"))
    with pytest.raises(ValueError):
        codec.decode(bytes(encoded))


def test_changed_compressed_file_invalidates_cached_ref(tmp_path):
    store = ContentAddressedArtifactStore(tmp_path, storage_mode="compressed")
    item = store.put_json(key="test.json", payload={"text": "abc" * 1000})
    store.get_ref(item.ref.artifact_id)
    damaged = bytearray(item.path.read_bytes())
    damaged[-6] ^= 255
    item.path.write_bytes(damaged)
    with pytest.raises(ArtifactIntegrityError):
        store.get_ref(item.ref.artifact_id)


def test_plain_small_files_and_invalid_configuration(tmp_path):
    assert codec.decode(b"{}") == b"{}"
    assert codec.encode(b"{}") == b"{}"
    with pytest.raises(ValueError, match="artifact storage"):
        ContentAddressedArtifactStore(tmp_path, storage_mode="invalid")
    # Empty payloads are a valid format edge even though envelopes are nonempty.
    empty = codec.MAGIC + bytes(8) + hashlib.sha256(b"").digest() + gzip.compress(b"")
    assert codec.decode(empty) == b""
