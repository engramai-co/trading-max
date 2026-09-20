"""Immutable compressed records with a rebuildable SQLite location index.

Packs are authoritative and self describing. The index is only a locator, never
an independent source of record bytes. Publication fsyncs the pack before one
SQLite transaction exposes its entries. Existing keys cannot change.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import struct
import threading
import uuid
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from contextlib import closing
from pathlib import Path, PurePosixPath

import zstandard as zstd

from .durable_files import atomic_bytes, durable_directory, sync_directory

MAGIC = b"TMPACK1\0"
MAX_BYTES = 64 * 1024 * 1024
MAX_INDEX = 16 * 1024 * 1024
MAX_RECORDS = 100_000
_DIGEST = re.compile(r"[0-9a-f]{64}")
_SCHEMA = """
CREATE TABLE packs (digest TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE records (
    key TEXT PRIMARY KEY, pack TEXT NOT NULL REFERENCES packs(digest),
    offset INTEGER NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX record_digest ON records(digest);
PRAGMA user_version=1;
"""


def safe_key(key: str) -> str:
    if not isinstance(key, str):
        raise ValueError("invalid packed record key")
    path = PurePosixPath(key)
    if (
        not key
        or len(key.encode()) > 1024
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in key
        or "\0" in key
        or path.as_posix() != key
        or key == "."
    ):
        raise ValueError("invalid packed record key")
    return key


def stamp(path: Path) -> tuple[int, ...]:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("object packs must not follow symlinks")
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def _decode(frame: bytes, maximum: int) -> bytes:
    size = zstd.frame_content_size(frame)
    if not 0 <= size <= maximum:
        raise ValueError("packed frame exceeds size limit")
    raw = zstd.ZstdDecompressor(max_window_size=MAX_BYTES // 1024).decompress(
        frame, max_output_size=max(1, size), allow_extra_data=False
    )
    if len(raw) != size:
        raise ValueError("packed frame length mismatch")
    return raw


def encode(records: Mapping[str, bytes]) -> bytes:
    if not records or len(records) > MAX_RECORDS:
        raise ValueError("invalid packed record count")
    data = bytearray()
    entries = []
    for key, raw in sorted(records.items()):
        safe_key(key)
        if not isinstance(raw, bytes) or len(data) + len(raw) > MAX_BYTES:
            raise ValueError("packed records exceed byte limit")
        entries.append([key, len(data), len(raw), hashlib.sha256(raw).hexdigest()])
        data.extend(raw)
    metadata = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode()
    if len(metadata) > MAX_INDEX:
        raise ValueError("packed index exceeds byte limit")
    compressor = zstd.ZstdCompressor(level=9, write_checksum=True)
    header = compressor.compress(metadata)
    return MAGIC + struct.pack(">I", len(header)) + header + compressor.compress(data)


def decode(content: bytes) -> tuple[dict[str, tuple[int, int, str]], bytes]:
    if not content.startswith(MAGIC) or len(content) < 12:
        raise ValueError("unsupported object pack")
    size = struct.unpack(">I", content[8:12])[0]
    if not 0 < size <= MAX_INDEX or 12 + size >= len(content):
        raise ValueError("invalid object pack header")
    try:
        entries = json.loads(_decode(content[12 : 12 + size], MAX_INDEX))
        raw = _decode(content[12 + size :], MAX_BYTES)
    except (zstd.ZstdError, ValueError, TypeError) as exc:
        raise ValueError("object pack cannot be decoded") from exc
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_RECORDS:
        raise ValueError("invalid object pack entries")
    result = {}
    offset = 0
    for entry in entries:
        if not isinstance(entry, list) or len(entry) != 4:
            raise ValueError("invalid object pack entry")
        key, start, length, digest = entry
        safe_key(key)
        if (
            key in result
            or type(start) is not int
            or start != offset
            or type(length) is not int
            or length < 0
            or start + length > len(raw)
            or not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest)
        ):
            raise ValueError("invalid object pack record bounds")
        if hashlib.sha256(raw[start : start + length]).hexdigest() != digest:
            raise ValueError("object pack record checksum mismatch")
        result[key] = (start, length, digest)
        offset += length
    if offset != len(raw):
        raise ValueError("unindexed object pack bytes")
    return result, raw


class ObjectPacks:
    def __init__(self, root: Path, *, cache_bytes: int = 16 * 1024 * 1024):
        self.root = root.absolute()
        self.directory = self.root / "blocks"
        self.index = self.root / "index.sqlite3"
        self.cache_bytes = cache_bytes
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        self._index_inode: tuple[int, int] | None = None
        self._cache: OrderedDict[tuple, tuple[dict, bytes]] = OrderedDict()
        self._cached_bytes = 0

    def close(self) -> None:
        with self._lock:
            if self._connection:
                self._connection.close()
                self._connection = None
            self._cache.clear()
            self._cached_bytes = 0

    def _validate_root(self) -> None:
        if any(p.is_symlink() for p in (self.root, self.directory, self.index)):
            raise ValueError("object pack storage must not follow symlinks")

    def _reader(self) -> sqlite3.Connection | None:
        self._validate_root()
        if not self.index.exists():
            if self.directory.exists() and any(self.directory.glob("*.pack")):
                raise ValueError("object pack index missing; rebuild it before reading")
            return None
        identity = stamp(self.index)[:2]
        if self._connection is None or identity != self._index_inode:
            if self._connection:
                self._connection.close()
            self._connection = sqlite3.connect(
                self.index.as_uri() + "?mode=ro", uri=True, check_same_thread=False
            )
            self._connection.execute("PRAGMA query_only=ON")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._index_inode = identity
            if self._connection.execute("PRAGMA user_version").fetchone() != (1,):
                raise ValueError("unsupported object pack index")
        return self._connection

    def location(self, key: str) -> tuple | None:
        safe_key(key)
        with self._lock:
            reader = self._reader()
            if reader is None:
                return None
            return reader.execute(
                "SELECT pack, offset, size, digest FROM records WHERE key=?", (key,)
            ).fetchone()

    def find(self, digest: str, prefix: str) -> str | None:
        with self._lock:
            reader = self._reader()
            if reader is None:
                return None
            row = reader.execute(
                "SELECT key FROM records WHERE digest=? AND key>=? AND key<? LIMIT 1",
                (digest, prefix, prefix + "\U0010ffff"),
            ).fetchone()
            return row[0] if row else None

    def last_key(self, prefix: str) -> str | None:
        with self._lock:
            reader = self._reader()
            if reader is None:
                return None
            row = reader.execute(
                "SELECT key FROM records WHERE key>=? AND key<? ORDER BY key DESC LIMIT 1",
                (prefix, prefix + "\U0010ffff"),
            ).fetchone()
            return row[0] if row else None

    def contains(self, key: str) -> bool:
        return self.location(key) is not None

    def keys(self, prefix: str = "") -> list[str]:
        with self._lock:
            reader = self._reader()
            if reader is None:
                return []
            return [
                r[0]
                for r in reader.execute(
                    "SELECT key FROM records WHERE key>=? AND key<? ORDER BY key",
                    (prefix, prefix + "\U0010ffff"),
                )
            ]

    def path(self, digest: str) -> Path:
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("invalid object pack digest")
        self._validate_root()
        result = self.directory / (digest + ".pack")
        if result.is_symlink():
            raise ValueError("object packs must not be symlinks")
        return result

    def source(self, key: str) -> Path:
        row = self.location(key)
        if row is None:
            raise FileNotFoundError(key)
        return self.path(row[0])

    def _load(self, digest: str) -> tuple[dict, bytes]:
        path = self.path(digest)
        before = stamp(path)
        key = (digest, before)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        if before[2] > MAX_BYTES + MAX_INDEX + 1024 * 1024:
            raise ValueError("object pack exceeds file limit")
        content = path.read_bytes()
        if stamp(path) != before or hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("object pack checksum mismatch")
        result = decode(content)
        cost = len(result[1]) + sum(len(k) + 128 for k in result[0])
        if cost <= self.cache_bytes:
            while self._cache and self._cached_bytes + cost > self.cache_bytes:
                _, (old_entries, old_raw) = self._cache.popitem(last=False)
                self._cached_bytes -= len(old_raw) + sum(len(k) + 128 for k in old_entries)
            self._cache[key] = result
            self._cached_bytes += cost
        return result

    def read(self, key: str) -> bytes:
        with self._lock:
            row = self.location(key)
            if row is None:
                raise FileNotFoundError(key)
            pack, offset, size, digest = row
            entries, raw = self._load(pack)
            if entries.get(key) != (offset, size, digest):
                raise ValueError("object pack locator disagrees with sealed records")
            return raw[offset : offset + size]

    def read_many(self, keys: list[str], *, max_bytes: int | None = None) -> list[bytes]:
        """Batch a manifest's references and decode each sealed block once."""
        if len(keys) > 1_000_000:
            raise ValueError("too many packed record references")
        if not keys:
            return []
        if max_bytes is not None and (type(max_bytes) is not int or max_bytes < 0):
            raise ValueError("invalid packed read byte budget")
        for key in keys:
            safe_key(key)
        with self._lock:
            reader = self._reader()
            if reader is None:
                raise FileNotFoundError(keys[0])
            grouped = {}
            seen = set()
            total = 0
            for offset in range(0, len(keys), 400):
                part = keys[offset : offset + 400]
                placeholders = ",".join("?" for _ in part)
                rows = reader.execute(
                    "SELECT key, pack, offset, size, digest FROM records WHERE key IN ("  # noqa: S608 - only generated placeholders; keys are bound
                    + placeholders
                    + ")",
                    part,
                )
                for key, pack, start, size, digest in rows:
                    if key not in seen:
                        if size < 0:
                            raise ValueError("invalid packed record size")
                        total += size
                        seen.add(key)
                        if max_bytes is not None and total > max_bytes:
                            raise ValueError("packed records exceed read byte budget")
                    grouped.setdefault(pack, {})[key] = (start, size, digest)
            result = {}
            for pack, records in grouped.items():
                entries, raw = self._load(pack)
                for key, location in records.items():
                    if entries.get(key) != location:
                        raise ValueError("object pack locator disagrees with sealed records")
                    offset, size, _ = location
                    result[key] = raw[offset : offset + size]
            if missing := next((key for key in keys if key not in result), None):
                raise FileNotFoundError(missing)
            return [result[key] for key in keys]

    def add(self, records: Mapping[str, bytes]) -> dict:
        """Commit one bounded batch; callers serialize maintenance against GC."""
        self._validate_root()
        if (
            not self.index.exists()
            and self.directory.exists()
            and any(self.directory.glob("*.pack"))
        ):
            raise ValueError("object pack index missing; rebuild it before writing")
        durable_directory(self.directory)
        with self._lock, closing(sqlite3.connect(self.index, timeout=30)) as connection:
            self.index.chmod(0o600)
            connection.execute("PRAGMA foreign_keys=ON")
            # A rollback journal is short lived; there is no unbounded WAL or
            # separately backed-up mutable page history for this derived index.
            connection.execute("PRAGMA synchronous=FULL")
            if connection.execute("PRAGMA user_version").fetchone() == (0,):
                connection.executescript(_SCHEMA)
            if connection.execute("PRAGMA user_version").fetchone() != (1,):
                raise ValueError("unsupported object pack index")
            connection.execute("BEGIN IMMEDIATE")
            new = {}
            for key, raw in records.items():
                safe_key(key)
                old = connection.execute(
                    "SELECT size, digest FROM records WHERE key=?", (key,)
                ).fetchone()
                if old is not None:
                    if old != (len(raw), hashlib.sha256(raw).hexdigest()) or self.read(key) != raw:
                        raise ValueError("immutable packed record conflict")
                else:
                    new[key] = raw
            if not new:
                connection.rollback()
                return {"records": 0, "bytes": 0}
            content = encode(new)
            entries, decoded = decode(content)
            for key, (offset, size, _) in entries.items():
                if decoded[offset : offset + size] != new[key]:
                    raise ValueError("object pack roundtrip failed")
            digest = hashlib.sha256(content).hexdigest()
            path = self.path(digest)
            if path.exists():
                if path.read_bytes() != content:
                    raise ValueError("existing object pack checksum mismatch")
            else:
                atomic_bytes(path, content)
            connection.execute("INSERT OR IGNORE INTO packs VALUES (?)", (digest,))
            connection.executemany(
                "INSERT INTO records VALUES (?, ?, ?, ?, ?)",
                ((key, digest, *entry) for key, entry in entries.items()),
            )
            connection.commit()
            sync_directory(self.root)
            return {"records": len(new), "bytes": len(content), "pack": digest}

    def recover_pending(self) -> None:
        """Index fsynced packs left by an interrupted commit before reusing keys.

        The caller holds its repository/maintenance lock. Existing keys must
        still match; a conflicting or corrupt orphan stops the operation.
        """
        with self._lock:
            reader = self._reader()
            if reader is None:
                return
            known = {r[0] for r in reader.execute("SELECT digest FROM packs")}
            missing = [p for p in self.directory.glob("*.pack") if p.stem not in known]
            if not missing:
                return
            with closing(sqlite3.connect(self.index, timeout=30)) as connection:
                connection.execute("PRAGMA synchronous=FULL")
                connection.execute("BEGIN IMMEDIATE")
                for path in sorted(missing):
                    entries, _ = self._load(path.stem)
                    connection.execute("INSERT OR IGNORE INTO packs VALUES (?)", (path.stem,))
                    for key, entry in entries.items():
                        old = connection.execute(
                            "SELECT size, digest FROM records WHERE key=?", (key,)
                        ).fetchone()
                        if old is not None and old != entry[1:]:
                            raise ValueError("conflicting interrupted object pack")
                        connection.execute(
                            "INSERT OR IGNORE INTO records VALUES (?, ?, ?, ?, ?)",
                            (key, path.stem, *entry),
                        )
                connection.commit()

    def rebuild(self) -> dict:
        """Reconstruct a locator independently from every sealed pack.

        Operator must hold the installation/repository maintenance lock. The old
        index remains in place on any corrupt pack or conflicting record.
        """
        self._validate_root()
        self.close()
        durable_directory(self.root)
        temporary = self.root / (".rebuild-" + uuid.uuid4().hex)
        count = 0
        try:
            with closing(sqlite3.connect(temporary)) as connection:
                temporary.chmod(0o600)
                connection.executescript(_SCHEMA)
                for path in sorted(self.directory.glob("*.pack")):
                    if path != self.path(path.stem):
                        raise ValueError("invalid object pack filename")
                    entries, _ = self._load(path.stem)
                    connection.execute("INSERT INTO packs VALUES (?)", (path.stem,))
                    for key, entry in entries.items():
                        old = connection.execute(
                            "SELECT size, digest FROM records WHERE key=?", (key,)
                        ).fetchone()
                        if old is not None and old != entry[1:]:
                            raise ValueError("conflicting records during index rebuild")
                        connection.execute(
                            "INSERT OR IGNORE INTO records VALUES (?, ?, ?, ?, ?)",
                            (key, path.stem, *entry),
                        )
                    count += len(entries)
                connection.commit()
                if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("rebuilt object index failed integrity check")
            with self._lock:
                self.close()
                with temporary.open("rb") as handle:
                    import os

                    os.fsync(handle.fileno())
                temporary.replace(self.index)
                sync_directory(self.root)
            return {"records": count}
        finally:
            temporary.unlink(missing_ok=True)

    def physical_paths(self, keys: Iterable[str]) -> list[Path]:
        return list(dict.fromkeys(self.source(key) for key in keys))
