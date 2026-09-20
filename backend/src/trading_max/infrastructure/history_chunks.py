"""Lossless physical history blocks; logical artifact identities stay unchanged."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

FORMAT = "trading-max-history-v1"
HISTORY_KEYS = {"account/nav/valuation_history.json", "account/nav/intraday_anchors.json"}
_DIGEST = re.compile(r"[0-9a-f]{64}")
_POINTS_PER_BLOCK = 512
_MAX_BLOCK_BYTES = 16 * 1024 * 1024
_MAX_ENVELOPE_BYTES = 256 * 1024 * 1024


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sync_directory(path: Path) -> None:
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def durable_directory(path: Path) -> None:
    missing = []
    parent = path
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in reversed(missing):
        sync_directory(directory.parent)


def atomic_bytes(path: Path, content: bytes) -> None:
    durable_directory(path.parent)
    if path.is_symlink():
        raise ValueError("history storage must not follow symlinks")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        Path(temporary).replace(path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _utc_day(point: dict) -> str:
    instant = datetime.fromisoformat(point["bucket_at"])
    if instant.tzinfo is None:
        raise ValueError("history blocks require an explicit observation timezone")
    return instant.astimezone(UTC).date().isoformat()


class HistoryChunks:
    def __init__(self, artifact_root: Path):
        self.root = artifact_root / "history-chunks"

    def path(self, digest: str) -> Path:
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("invalid history block digest")
        path = self.root / digest[:2] / (digest + ".gz")
        if self.root.is_symlink() or path.parent.is_symlink() or path.is_symlink():
            raise ValueError("history blocks must not be symlinks")
        return path

    def _store(self, values: list) -> dict:
        raw = canonical(values)
        if len(raw) > _MAX_BLOCK_BYTES:
            raise ValueError("history block exceeds size limit")
        digest = hashlib.sha256(raw).hexdigest()
        block = {"sha256": digest, "bytes": len(raw)}
        path = self.path(digest)
        if path.exists():
            self._read(block)  # Never reuse already-corrupt content.
        else:
            atomic_bytes(path, gzip.compress(raw, compresslevel=3, mtime=0))
        return block

    def _read(self, block: dict) -> list:
        size = block["bytes"]
        if type(size) is not int or not 0 <= size <= _MAX_BLOCK_BYTES:
            raise ValueError("invalid history block size")
        try:
            with gzip.open(self.path(block["sha256"]), "rb") as stream:
                raw = stream.read(size + 1)
        except (OSError, EOFError) as exc:
            raise ValueError("history block cannot be decompressed") from exc
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != block["sha256"]:
            raise ValueError("history block checksum mismatch")
        values = json.loads(raw)
        if not isinstance(values, list):
            raise ValueError("history block must contain an array")
        return values

    def encode(self, raw: bytes) -> dict:
        if len(raw) > _MAX_ENVELOPE_BYTES:
            raise ValueError("history envelope exceeds size limit")
        envelope = json.loads(raw)
        payload = envelope["payload"]
        if envelope["ref"]["key"] not in HISTORY_KEYS or not isinstance(payload["points"], list):
            raise ValueError("unsupported history envelope")
        chunks = []
        # Consecutive groups preserve exact order, including out-of-order dates.
        for day, group in groupby(payload["points"], _utc_day):
            points = list(group)
            for start in range(0, len(points), _POINTS_PER_BLOCK):
                part = points[start : start + _POINTS_PER_BLOCK]
                values = [{k: v for k, v in p.items() if k != "source_artifact_ids"} for p in part]
                sources = [["source_artifact_ids" in p, p.get("source_artifact_ids")] for p in part]
                chunks.append(
                    {
                        "day": day,
                        "count": len(part),
                        "values": self._store(values),
                        "sources": self._store(sources),
                    }
                )
        descriptor = {
            "$format": FORMAT,
            "artifactId": envelope["ref"]["artifact_id"],
            "envelopeSha256": hashlib.sha256(raw).hexdigest(),
            "envelopeBytes": len(raw),
            "envelope": {
                **envelope,
                "payload": {k: v for k, v in payload.items() if k != "points"},
            },
            "chunks": chunks,
        }
        if self.decode(descriptor) != raw:
            raise ValueError("history representation failed byte-exact verification")
        return descriptor

    def paths(self, descriptor: dict) -> list[Path]:
        if descriptor.get("$format") != FORMAT:
            raise ValueError("unsupported history storage format")
        return list(
            dict.fromkeys(
                self.path(chunk[k]["sha256"])
                for chunk in descriptor["chunks"]
                for k in ("values", "sources")
            )
        )

    def decode(self, descriptor: dict) -> bytes:
        self.paths(descriptor)
        size = descriptor["envelopeBytes"]
        if type(size) is not int or not 0 <= size <= _MAX_ENVELOPE_BYTES:
            raise ValueError("invalid history envelope size")
        points = []
        decoded_bytes = 0
        for chunk in descriptor["chunks"]:
            count = chunk["count"]
            if type(count) is not int or not 1 <= count <= _POINTS_PER_BLOCK:
                raise ValueError("invalid history block count")
            decoded_bytes += chunk["values"]["bytes"] + chunk["sources"]["bytes"]
            if decoded_bytes > _MAX_ENVELOPE_BYTES * 2:
                raise ValueError("history representation exceeds size limit")
            values, sources = self._read(chunk["values"]), self._read(chunk["sources"])
            if len(values) != count or len(sources) != count:
                raise ValueError("history block count mismatch")
            for value, source in zip(values, sources, strict=True):
                if not isinstance(value, dict) or "source_artifact_ids" in value:
                    raise ValueError("invalid history value")
                if not isinstance(source, list) or len(source) != 2 or type(source[0]) is not bool:
                    raise ValueError("invalid history provenance")
                point = {**value, "source_artifact_ids": source[1]} if source[0] else value
                if _utc_day(point) != chunk["day"]:
                    raise ValueError("history block date mismatch")
                points.append(point)
        envelope = descriptor["envelope"]
        if envelope["ref"]["artifact_id"] != descriptor["artifactId"]:
            raise ValueError("history descriptor identity mismatch")
        raw = canonical({**envelope, "payload": {**envelope["payload"], "points": points}})
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != descriptor["envelopeSha256"]:
            raise ValueError("history envelope checksum mismatch")
        return raw


def read_descriptor(path: Path) -> dict | None:
    """Avoid loading a large legacy object just to inspect its physical format."""
    with path.open("rb") as stream:
        if not stream.read(64).startswith(b'{"$format":'):
            return None
        stream.seek(0)
        raw = stream.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("history descriptor exceeds size limit")
    descriptor = json.loads(raw)
    if descriptor.get("$format") not in {FORMAT, "trading-max-json-v1"}:
        raise ValueError("unsupported history storage format")
    return descriptor
