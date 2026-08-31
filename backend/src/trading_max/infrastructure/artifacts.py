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
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from trading_max.domain import ArtifactQuality, ArtifactRef

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
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


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

    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()
        self.content_root = self.root / "sha256"

    def path_for(self, artifact_id: str) -> Path:
        if len(artifact_id) != 64 or any(
            character not in "0123456789abcdef" for character in artifact_id
        ):
            raise ValueError(f"invalid artifact id: {artifact_id}")
        return self.content_root / artifact_id

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
        if path.is_file():
            # generated_at is intentionally not part of the content identity;
            # preserve the first immutable envelope instead of rewriting it
            # with a different timestamp on an idempotent publish.
            return self.get_json(digest)
        _atomic_write(path, content)
        return StoredArtifact(ref=ref, payload=dict(payload), path=path)

    def get_json(self, artifact_id: str) -> StoredArtifact:
        path = self.path_for(artifact_id)
        if not path.is_file():
            raise FileNotFoundError(f"artifact not found: {artifact_id}")
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
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
        if not path.is_file():
            _atomic_write(path, content)
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
        if (
            ref.artifact_id != artifact_id
            or ref.sha256 != expected
            or hashlib.sha256(content).hexdigest() != expected
        ):
            raise ArtifactIntegrityError(f"byte artifact digest mismatch: {artifact_id}")
        return StoredBytes(ref=ref, path=path)

    def get_ref(self, artifact_id: str) -> ArtifactRef:
        """Validate and return the reference for either artifact media type."""

        metadata_path = self.path_for(artifact_id).with_name(f"{artifact_id}.meta.json")
        if metadata_path.is_file():
            return self.get_bytes(artifact_id).ref
        return self.get_json(artifact_id).ref


__all__ = [
    "ArtifactConflict",
    "ArtifactIntegrityError",
    "ContentAddressedArtifactStore",
    "StoredArtifact",
    "StoredBytes",
]
