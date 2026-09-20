"""Bounded, lossless storage for immutable JSON envelopes; identities stay logical."""

from __future__ import annotations

import gzip
import hashlib
import io
import zlib
from pathlib import Path

MAGIC = b"TMJSON1\0"
HEADER_BYTES = len(MAGIC) + 8 + 32
MAX_BYTES = 256 * 1024 * 1024


def header(content: bytes) -> tuple[int, bytes] | None:
    if not content.startswith(MAGIC):
        return None
    if len(content) < HEADER_BYTES:
        raise ValueError("truncated compressed JSON header")
    size = int.from_bytes(content[len(MAGIC) : len(MAGIC) + 8], "big")
    if size > MAX_BYTES:
        raise ValueError("compressed JSON exceeds size limit")
    return size, content[len(MAGIC) + 8 : HEADER_BYTES]


def stored_size(path: Path) -> int | None:
    with path.open("rb") as stream:
        metadata = header(stream.read(HEADER_BYTES))
    return metadata[0] if metadata else None


def encode(content: bytes) -> bytes:
    if len(content) > MAX_BYTES:
        raise ValueError("JSON envelope exceeds compression limit")
    encoded = (
        MAGIC
        + len(content).to_bytes(8, "big")
        + hashlib.sha256(content).digest()
        + gzip.compress(content, compresslevel=3, mtime=0)
    )
    return encoded if len(encoded) < len(content) else content


def decode(content: bytes) -> bytes:
    metadata = header(content)
    if metadata is None:
        return content
    size, expected = metadata
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(content[HEADER_BYTES:])) as stream:
            raw = stream.read(size + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise ValueError("compressed JSON cannot be decoded") from exc
    if len(raw) != size or hashlib.sha256(raw).digest() != expected:
        raise ValueError("compressed JSON checksum mismatch")
    return raw
