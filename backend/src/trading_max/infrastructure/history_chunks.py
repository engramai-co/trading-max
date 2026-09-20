"""Lossless physical history blocks; logical artifact identities stay unchanged."""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

from .durable_files import atomic_bytes, durable_directory, sync_directory  # noqa: F401
from .object_packs import ObjectPacks
from .verified_chunks import VerifiedChunkCache, read_packable_chunk, read_packable_chunks

FORMAT = "trading-max-history-v1"
HISTORY_KEYS = {"account/nav/valuation_history.json", "account/nav/intraday_anchors.json"}
_DIGEST = re.compile(r"[0-9a-f]{64}")
_POINTS_PER_BLOCK = 512
_MAX_BLOCK_BYTES = 16 * 1024 * 1024
_MAX_ENVELOPE_BYTES = 256 * 1024 * 1024


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _utc_day(point: dict) -> str:
    instant = datetime.fromisoformat(point["bucket_at"])
    if instant.tzinfo is None:
        raise ValueError("history blocks require an explicit observation timezone")
    return instant.astimezone(UTC).date().isoformat()


class HistoryChunks:
    def __init__(self, artifact_root: Path, *, packs: ObjectPacks | None = None):
        self.root = artifact_root / "history-chunks"
        self.read_cache: VerifiedChunkCache | None = None
        self.packs = packs or ObjectPacks(artifact_root / "object-packs")

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
        if path.exists() or self.packs.contains("history/" + digest):
            self._read(block)  # Never reuse already-corrupt content.
        else:
            atomic_bytes(path, gzip.compress(raw, compresslevel=3, mtime=0))
        return block

    def _read(self, block: dict, raw: bytes | None = None) -> list:
        size = block["bytes"]
        if type(size) is not int or not 0 <= size <= _MAX_BLOCK_BYTES:
            raise ValueError("invalid history block size")
        digest = block["sha256"]
        if raw is None:
            raw = read_packable_chunk(
                self.path(digest), size, digest, self.packs, "history/" + digest, self.read_cache
            )
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
        records = []
        for chunk in descriptor["chunks"]:
            count = chunk["count"]
            if type(count) is not int or not 1 <= count <= _POINTS_PER_BLOCK:
                raise ValueError("invalid history block count")
            decoded_bytes += chunk["values"]["bytes"] + chunk["sources"]["bytes"]
            if decoded_bytes > _MAX_ENVELOPE_BYTES * 2:
                raise ValueError("history representation exceeds size limit")
            for kind in ("values", "sources"):
                block = chunk[kind]
                if type(block["bytes"]) is not int or not 0 <= block["bytes"] <= _MAX_BLOCK_BYTES:
                    raise ValueError("invalid history block size")
                digest = block["sha256"]
                records.append((self.path(digest), block["bytes"], digest, "history/" + digest))
        raw_chunks = read_packable_chunks(
            records, self.packs, self.read_cache, max_bytes=_MAX_ENVELOPE_BYTES * 2
        )
        for chunk in descriptor["chunks"]:
            count = chunk["count"]
            values = self._read(chunk["values"], raw_chunks["history/" + chunk["values"]["sha256"]])
            sources = self._read(
                chunk["sources"], raw_chunks["history/" + chunk["sources"]["sha256"]]
            )
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
