"""Content-addressed immutable artifact storage.

The API compatibility store still reads historical report files. New worker
stages must write through this repository instead: an artifact is identified by
its canonical input payload and producer metadata, not by a mutable filename or
filesystem mtime.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from trading_max.domain import ArtifactQuality, ArtifactRef

from . import compressed_json
from .history_chunks import HISTORY_KEYS, HistoryChunks, atomic_bytes, canonical, read_descriptor
from .json_chunks import FORMAT as JSON_CHUNKS_FORMAT
from .json_chunks import JsonChunks
from .object_packs import ObjectPacks
from .object_packs import stamp as pack_stamp
from .singleflight import SingleFlightCache

JsonObject = dict[str, Any]


class ArtifactIntegrityError(RuntimeError):
    """The stored envelope does not match its content-addressed reference."""


class ArtifactConflict(RuntimeError):
    """An artifact ID already exists with different bytes."""


def _canonical_json(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _safe_key(key: str) -> str:
    parsed = PurePosixPath(key)
    if parsed.is_absolute() or ".." in parsed.parts or not parsed.parts:
        raise ValueError(f"unsafe artifact key: {key}")
    return parsed.as_posix()


def _identity(
    *,
    schema_version: int,
    key: str,
    kind: str,
    media_type: str,
    as_of: str | None,
    producer_version: str,
    dependency_artifact_ids: list[str],
    quality: ArtifactQuality,
    payload: Mapping[str, Any],
) -> JsonObject:
    return {
        "schema_version": schema_version,
        "key": key,
        "kind": kind,
        "media_type": media_type,
        "as_of": as_of,
        "producer_version": producer_version,
        "dependency_artifact_ids": dependency_artifact_ids,
        "quality": quality.model_dump(mode="json", by_alias=False),
        "payload": dict(payload),
    }


def _atomic_write(path: Path, content: bytes) -> None:
    atomic_bytes(path, content)


@dataclass(frozen=True, slots=True)
class StoredArtifact:
    ref: ArtifactRef
    payload: JsonObject
    path: Path


@dataclass(frozen=True, slots=True)
class StoredBytes:
    ref: ArtifactRef
    path: Path


class ContentAddressedArtifactStore:
    """Store JSON envelopes under ``sha256/<artifact-id>`` atomically."""

    def __init__(
        self, root: Path, *, history_mode: str | None = None, storage_mode: str | None = None
    ) -> None:
        self.root = root.expanduser().resolve()
        self.content_root = self.root / "sha256"
        self.packs = ObjectPacks(self.root / "object-packs")
        self.history = HistoryChunks(self.root, packs=self.packs)
        self.json_chunks = JsonChunks(self.root, packs=self.packs)
        self.history_mode = history_mode or os.environ.get("TRADING_MAX_HISTORY_STORAGE", "legacy")
        if self.history_mode not in {"legacy", "shadow", "chunked"}:
            raise ValueError("history storage must be legacy, shadow or chunked")
        self.storage_mode = storage_mode or os.environ.get("TRADING_MAX_ARTIFACT_STORAGE", "legacy")
        if self.storage_mode not in {"legacy", "compressed", "chunked"}:
            raise ValueError("artifact storage must be legacy, compressed or chunked")
        self._descriptors: SingleFlightCache[tuple, dict | None] = SingleFlightCache(256)
        self._verified_refs: SingleFlightCache[tuple, ArtifactRef] = SingleFlightCache(256)

    def path_for(self, artifact_id: str) -> Path:
        if len(artifact_id) != 64 or any(
            character not in "0123456789abcdef" for character in artifact_id
        ):
            raise ValueError(f"invalid artifact id: {artifact_id}")
        return self.content_root / artifact_id

    def exists(self, artifact_id: str) -> bool:
        return self.path_for(artifact_id).is_file() or self.packs.contains(
            "artifact/" + artifact_id
        )

    def artifact_ids(self) -> list[str]:
        loose = {p.name for p in self.content_root.glob("*") if len(p.name) == 64 and p.is_file()}
        return sorted(loose | {k.removeprefix("artifact/") for k in self.packs.keys("artifact/")})

    def stored_bytes(self, artifact_id: str) -> bytes:
        path = self.path_for(artifact_id)
        return path.read_bytes() if path.is_file() else self.packs.read("artifact/" + artifact_id)

    def source_path(self, artifact_id: str) -> Path:
        path = self.path_for(artifact_id)
        return path if path.is_file() else self.packs.source("artifact/" + artifact_id)

    def put_json(
        self,
        *,
        key: str,
        payload: Mapping[str, Any],
        kind: str = "artifact",
        schema_version: int = 1,
        media_type: str = "application/json",
        as_of: str | None = None,
        producer_version: str = "unknown",
        dependency_artifact_ids: list[str] | None = None,
        quality: ArtifactQuality | None = None,
    ) -> StoredArtifact:
        self.content_root.mkdir(parents=True, exist_ok=True)
        safe_key = _safe_key(key)
        dependencies = list(dependency_artifact_ids or [])
        artifact_quality = quality or ArtifactQuality()
        identity = _identity(
            schema_version=schema_version,
            key=safe_key,
            kind=kind,
            media_type=media_type,
            as_of=as_of,
            producer_version=producer_version,
            dependency_artifact_ids=dependencies,
            quality=artifact_quality,
            payload=payload,
        )
        digest = hashlib.sha256(_canonical_json(identity)).hexdigest()
        ref = ArtifactRef(
            schema_version=schema_version,
            artifact_id=digest,
            key=safe_key,
            kind=kind,
            sha256=digest,
            media_type=media_type,
            as_of=as_of,
            producer_version=producer_version,
            dependency_artifact_ids=dependencies,
            quality=artifact_quality,
        )
        envelope = {
            "ref": ref.model_dump(mode="json", by_alias=False),
            "payload": dict(payload),
        }
        content = _canonical_json(envelope)
        path = self.path_for(digest)
        if self.exists(digest):
            # generated_at is intentionally not part of the content identity;
            # preserve the first immutable envelope instead of rewriting it
            # with a different timestamp on an idempotent publish.
            return self.get_json(digest)
        if safe_key in HISTORY_KEYS and self.history_mode != "legacy":
            descriptor = self.history.encode(content)
            if self.history_mode == "shadow":
                _atomic_write(
                    self.root / "history-shadow" / f"{digest}.json", canonical(descriptor)
                )
            else:
                content = canonical(descriptor)
        if self.storage_mode != "legacy" and not (
            safe_key in HISTORY_KEYS and self.history_mode == "chunked"
        ):
            content = (
                canonical(self.json_chunks.encode(content))
                if self.storage_mode == "chunked" and len(content) > 64 * 1024
                else compressed_json.encode(content)
            )
        _atomic_write(path, content)
        self._verified_refs.get_or_compute(self._ref_key(digest), lambda: ref.model_copy(deep=True))
        return StoredArtifact(ref=ref, payload=dict(payload), path=path)

    def get_json(self, artifact_id: str) -> StoredArtifact:
        path = self.path_for(artifact_id)
        if not self.exists(artifact_id):
            raise FileNotFoundError(f"artifact not found: {artifact_id}")
        try:
            envelope = json.loads(self.content_bytes(artifact_id))
            ref = ArtifactRef.model_validate(envelope["ref"])
            payload = envelope["payload"]
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ArtifactIntegrityError(f"invalid artifact envelope: {artifact_id}") from exc
        if not isinstance(payload, dict) or ref.artifact_id != artifact_id:
            raise ArtifactIntegrityError(f"artifact identity mismatch: {artifact_id}")
        identity = _identity(
            schema_version=ref.schema_version,
            key=ref.key,
            kind=ref.kind,
            media_type=ref.media_type,
            as_of=ref.as_of,
            producer_version=ref.producer_version,
            dependency_artifact_ids=ref.dependency_artifact_ids,
            quality=ref.quality,
            payload=payload,
        )
        digest = hashlib.sha256(_canonical_json(identity)).hexdigest()
        if digest != artifact_id or ref.sha256 != digest:
            raise ArtifactIntegrityError(f"artifact digest mismatch: {artifact_id}")
        return StoredArtifact(ref=ref, payload=payload, path=path)

    def descriptor(self, artifact_id: str) -> dict | None:
        path = self.path_for(artifact_id)
        source = self.source_path(artifact_id)
        key = (
            artifact_id,
            pack_stamp(source),
            pack_stamp(self.packs.index) if source != path else (),
        )

        def load():
            if path.is_file():
                return read_descriptor(path)
            raw = self.stored_bytes(artifact_id)
            if not raw.startswith(b'{"$format":'):
                return None
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("packed artifact descriptor exceeds limit")
            value = json.loads(raw)
            if value.get("$format") not in {"trading-max-history-v1", JSON_CHUNKS_FORMAT}:
                raise ValueError("unsupported packed artifact descriptor")
            return value

        return self._descriptors.get_or_compute(key, load)

    def content_bytes(self, artifact_id: str) -> bytes:
        """Return the original envelope, never a physical storage descriptor."""
        try:
            descriptor = self.descriptor(artifact_id)
            if descriptor is None:
                raw = self.stored_bytes(artifact_id)
                if self.path_for(artifact_id).with_name(f"{artifact_id}.meta.json").is_file():
                    return raw
                return compressed_json.decode(raw)
            if descriptor["artifactId"] != artifact_id:
                raise ValueError("history descriptor identity mismatch")
            return self.physical_store(descriptor).decode(descriptor)
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ArtifactIntegrityError(f"invalid history representation: {artifact_id}") from exc

    def logical_size(self, artifact_id: str) -> int:
        path = self.path_for(artifact_id)
        if path.with_name(f"{artifact_id}.meta.json").is_file():
            return path.stat().st_size
        descriptor = self.descriptor(artifact_id)
        if descriptor:
            return descriptor["envelopeBytes"]
        if not path.is_file():
            return len(compressed_json.decode(self.stored_bytes(artifact_id)))
        size = compressed_json.stored_size(path)
        return path.stat().st_size if size is None else size

    def physical_store(self, descriptor: dict) -> HistoryChunks | JsonChunks:
        return self.json_chunks if descriptor.get("$format") == JSON_CHUNKS_FORMAT else self.history

    def logical_paths(self, descriptor: dict) -> list[Path]:
        return self.physical_store(descriptor).paths(descriptor)

    def physical_paths(self, descriptor: dict) -> list[Path]:
        result = []
        for path in self.logical_paths(descriptor):
            kind = "json" if path.parent.parent.name == "json-chunks" else "history"
            result.append(path if path.is_file() else self.packs.source(kind + "/" + path.stem))
        return list(dict.fromkeys(result))

    def requires_decoding(self, artifact_id: str) -> bool:
        path = self.path_for(artifact_id)
        if path.with_name(f"{artifact_id}.meta.json").is_file():
            return False
        return (
            not path.is_file()
            or self.descriptor(artifact_id) is not None
            or compressed_json.stored_size(path) is not None
        )

    def put_bytes(
        self,
        *,
        key: str,
        content: bytes,
        kind: str = "artifact",
        schema_version: int = 1,
        media_type: str = "application/octet-stream",
        as_of: str | None = None,
        producer_version: str = "unknown",
        dependency_artifact_ids: list[str] | None = None,
        quality: ArtifactQuality | None = None,
    ) -> StoredBytes:
        """Store a non-JSON artifact with a signed sidecar envelope."""

        self.content_root.mkdir(parents=True, exist_ok=True)
        safe_key = _safe_key(key)
        dependencies = list(dependency_artifact_ids or [])
        artifact_quality = quality or ArtifactQuality()
        content_sha256 = hashlib.sha256(content).hexdigest()
        identity = {
            "schema_version": schema_version,
            "key": safe_key,
            "kind": kind,
            "media_type": media_type,
            "as_of": as_of,
            "producer_version": producer_version,
            "dependency_artifact_ids": dependencies,
            "quality": artifact_quality.model_dump(mode="json", by_alias=False),
            "content_sha256": content_sha256,
        }
        digest = hashlib.sha256(_canonical_json(identity)).hexdigest()
        ref = ArtifactRef(
            schema_version=schema_version,
            artifact_id=digest,
            key=safe_key,
            kind=kind,
            sha256=content_sha256,
            media_type=media_type,
            as_of=as_of,
            producer_version=producer_version,
            dependency_artifact_ids=dependencies,
            quality=artifact_quality,
        )
        path = self.path_for(digest)
        metadata_path = path.with_name(f"{digest}.meta.json")
        if path.is_file() and metadata_path.is_file():
            return self.get_bytes(digest)
        if path.is_file():
            if path.read_bytes() != content:
                raise ArtifactIntegrityError(f"byte artifact digest mismatch: {digest}")
        else:
            _atomic_write(path, content)
        # A stopped writer may have committed content before its sidecar.
        # Retry that incomplete write only after the bytes match this identity.
        _atomic_write(
            metadata_path,
            _canonical_json(
                {
                    "ref": ref.model_dump(mode="json", by_alias=False),
                    "content_sha256": content_sha256,
                }
            ),
        )
        return StoredBytes(ref=ref, path=path)

    def get_bytes(self, artifact_id: str) -> StoredBytes:
        path = self.path_for(artifact_id)
        metadata_path = path.with_name(f"{artifact_id}.meta.json")
        if not path.is_file() or not metadata_path.is_file():
            raise FileNotFoundError(f"byte artifact not found: {artifact_id}")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            ref = ArtifactRef.model_validate(metadata["ref"])
            expected = str(metadata["content_sha256"])
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise ArtifactIntegrityError(f"invalid byte artifact envelope: {artifact_id}") from exc
        content = path.read_bytes()
        identity = {
            "schema_version": ref.schema_version,
            "key": ref.key,
            "kind": ref.kind,
            "media_type": ref.media_type,
            "as_of": ref.as_of,
            "producer_version": ref.producer_version,
            "dependency_artifact_ids": ref.dependency_artifact_ids,
            "quality": ref.quality.model_dump(mode="json", by_alias=False),
            "content_sha256": expected,
        }
        if (
            ref.artifact_id != artifact_id
            or ref.sha256 != expected
            or hashlib.sha256(content).hexdigest() != expected
            or hashlib.sha256(_canonical_json(identity)).hexdigest() != artifact_id
        ):
            raise ArtifactIntegrityError(f"byte artifact digest mismatch: {artifact_id}")
        return StoredBytes(ref=ref, path=path)

    def _ref_key(self, artifact_id: str) -> tuple:

        path = self.path_for(artifact_id)
        metadata_path = path.with_name(f"{artifact_id}.meta.json")

        def stamp(file: Path) -> tuple:
            stat = file.stat()
            return stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns

        descriptor = self.descriptor(artifact_id) if not metadata_path.is_file() else None
        chunks = (
            tuple(stamp(block) for block in self.physical_paths(descriptor)) if descriptor else ()
        )
        return (
            artifact_id,
            stamp(self.source_path(artifact_id)),
            pack_stamp(self.packs.index) if self.packs.index.is_file() else (),
            stamp(metadata_path) if metadata_path.is_file() else None,
            chunks,
        )

    def get_ref(self, artifact_id: str) -> ArtifactRef:
        """Validate and return the reference for either artifact media type."""
        path = self.path_for(artifact_id)
        metadata_path = path.with_name(f"{artifact_id}.meta.json")
        key = self._ref_key(artifact_id)

        def validate() -> ArtifactRef:
            if metadata_path.is_file():
                return self.get_bytes(artifact_id).ref
            return self.get_json(artifact_id).ref

        # Reuse only a reference already verified against unchanged file bytes.
        # A replacement, edit, or deleted file forces validation again.
        return self._verified_refs.get_or_compute(key, validate).model_copy(deep=True)


__all__ = [
    "ArtifactConflict",
    "ArtifactIntegrityError",
    "ContentAddressedArtifactStore",
    "StoredArtifact",
    "StoredBytes",
]
