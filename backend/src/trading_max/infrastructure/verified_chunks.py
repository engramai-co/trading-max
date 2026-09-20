"""Bounded, operation-local reuse of bytes already read and checksum verified."""

from __future__ import annotations

import gzip
import hashlib
import zlib
from collections import OrderedDict
from pathlib import Path


def _stamp(path: Path) -> tuple[int, ...]:
    try:
        info = path.stat()
    except OSError as exc:
        raise ValueError("chunk cannot be inspected") from exc
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_verified(path: Path, size: int, digest: str) -> bytes:
    try:
        with gzip.open(path, "rb") as stream:
            raw = stream.read(size + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise ValueError("chunk cannot be decompressed") from exc
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("chunk checksum mismatch")
    return raw


class VerifiedChunkCache:
    """Immutable byte cache; discard it after each locked backup verification.

    Recheck source identity even on a cache hit. The next verify or restore gets
    a new cache and reads physical bytes again. Every original envelope still
    undergoes full reconstruction and its own end-to-end checksum validation.
    """

    def __init__(self, max_bytes: int = 16 * 1024 * 1024, max_entries: int = 512):
        if min(max_bytes, max_entries) <= 0:
            raise ValueError("chunk cache budgets must be positive")
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.bytes = 0
        self.entries: OrderedDict[tuple, bytes] = OrderedDict()

    def read(self, path: Path, size: int, digest: str) -> bytes:
        before = _stamp(path)
        key = (str(path), size, digest, before)
        if key in self.entries:
            self.entries.move_to_end(key)
            return self.entries[key]
        raw = read_verified(path, size, digest)
        if _stamp(path) != before:
            raise ValueError("chunk changed while being verified")
        return self._remember(key, raw)

    def read_packed(self, packs, record: str, size: int, digest: str) -> bytes:
        path = packs.source(record)
        before = _stamp(path)
        key = (str(path), record, size, digest, before)
        if key in self.entries:
            self.entries.move_to_end(key)
            return self.entries[key]
        raw = packs.read(record)
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("packed chunk checksum mismatch")
        if _stamp(path) != before:
            raise ValueError("packed chunk changed while being verified")
        return self._remember(key, raw)

    def _remember(self, key: tuple, raw: bytes) -> bytes:
        if len(raw) <= self.max_bytes:
            while self.entries and (
                self.bytes + len(raw) > self.max_bytes or len(self.entries) >= self.max_entries
            ):
                _, evicted = self.entries.popitem(last=False)
                self.bytes -= len(evicted)
            self.entries[key] = raw
            self.bytes += len(raw)
        return raw


def read_packable_chunk(path: Path, size: int, digest: str, packs, key: str, cache=None) -> bytes:
    """A concurrently retired alias can only fall through on ENOENT, never corruption."""
    reader = cache.read if cache else read_verified
    try:
        return reader(path, size, digest)
    except (ValueError, FileNotFoundError) as exc:
        if not isinstance(exc, FileNotFoundError) and not isinstance(
            exc.__cause__, FileNotFoundError
        ):
            raise
    try:
        raw = cache.read_packed(packs, key, size, digest) if cache else packs.read(key)
    except OSError as exc:
        raise ValueError("packed chunk cannot be read") from exc
    if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("packed chunk checksum mismatch")
    return raw
