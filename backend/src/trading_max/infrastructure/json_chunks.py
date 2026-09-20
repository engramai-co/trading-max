"""Lossless shared JSON subtrees for repeated research envelopes.

Only physical representation changes. Stable object keys and fixed array groups
reuse unchanged data; no financial records or provenance are removed.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import zlib
from pathlib import Path

from .history_chunks import atomic_bytes, canonical

FORMAT = "trading-max-json-v1"
MAX_BYTES = 256 * 1024 * 1024
TARGET_BYTES = 32 * 1024
GROUP_ITEMS = 128
_DIGEST = re.compile(r"[0-9a-f]{64}")


class JsonChunks:
    def __init__(self, artifact_root: Path):
        self.root = artifact_root / "json-chunks"

    def path(self, digest: str) -> Path:
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise ValueError("invalid JSON block digest")
        path = self.root / digest[:2] / (digest + ".gz")
        if self.root.is_symlink() or path.parent.is_symlink() or path.is_symlink():
            raise ValueError("JSON blocks must not be symlinks")
        return path

    def _store(self, raw: bytes) -> list:
        digest = hashlib.sha256(raw).hexdigest()
        node = ["blob", digest, len(raw)]
        path = self.path(digest)
        if path.exists():
            self._read(node)
        else:
            atomic_bytes(path, gzip.compress(raw, compresslevel=3, mtime=0))
        return node

    def _read(self, node: list) -> object:
        _, digest, size = node
        if type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise ValueError("invalid JSON block size")
        try:
            with gzip.open(self.path(digest), "rb") as stream:
                raw = stream.read(size + 1)
        except (OSError, EOFError, zlib.error) as exc:
            raise ValueError("JSON block cannot be decompressed") from exc
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("JSON block checksum mismatch")
        return json.loads(raw)

    def _encode(self, value: object, depth: int = 0) -> list:
        if depth > 64:
            raise ValueError("JSON tree exceeds depth limit")
        raw = canonical(value)
        if len(raw) <= TARGET_BYTES or not isinstance(value, (dict, list)):
            return self._store(raw)
        if isinstance(value, dict):
            return ["map", [[key, self._encode(value[key], depth + 1)] for key in sorted(value)]]
        if len(value) > GROUP_ITEMS:
            return [
                "concat",
                [
                    self._encode(value[i : i + GROUP_ITEMS], depth + 1)
                    for i in range(0, len(value), GROUP_ITEMS)
                ],
            ]
        return ["list", [self._encode(item, depth + 1) for item in value]]

    def encode(self, raw: bytes) -> dict:
        if len(raw) > MAX_BYTES:
            raise ValueError("JSON envelope exceeds size limit")
        envelope = json.loads(raw)
        descriptor = {
            "$format": FORMAT,
            "artifactId": envelope["ref"]["artifact_id"],
            "envelopeSha256": hashlib.sha256(raw).hexdigest(),
            "envelopeBytes": len(raw),
            "tree": self._encode(envelope),
        }
        if len(canonical(descriptor)) > 8 * 1024 * 1024:
            raise ValueError("JSON descriptor exceeds size limit")
        if self.decode(descriptor) != raw:
            raise ValueError("JSON representation failed byte-exact verification")
        return descriptor

    def paths(self, descriptor: dict) -> list[Path]:
        if descriptor.get("$format") != FORMAT:
            raise ValueError("unsupported JSON storage format")
        size = descriptor.get("envelopeBytes")
        if type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise ValueError("invalid JSON envelope size")
        pending = [(descriptor["tree"], 0)]
        count = total = 0
        paths = {}
        while pending:
            node, depth = pending.pop()
            count += 1
            if count > 500_000 or depth > 64 or not isinstance(node, list) or not node:
                raise ValueError("invalid JSON tree")
            if node[0] == "blob":
                if len(node) != 3 or type(node[2]) is not int or not 0 <= node[2] <= MAX_BYTES:
                    raise ValueError("invalid JSON block")
                total += node[2]
                if total > size + 2 * count or total > MAX_BYTES:
                    raise ValueError("JSON blocks exceed envelope size")
                paths[self.path(node[1])] = None
                continue
            if len(node) != 2 or not isinstance(node[1], list):
                raise ValueError("invalid JSON branch")
            if node[0] == "map":
                keys = []
                for pair in node[1]:
                    if not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str):
                        raise ValueError("invalid JSON map entry")
                    keys.append(pair[0])
                    pending.append((pair[1], depth + 1))
                if keys != sorted(set(keys)):
                    raise ValueError("JSON map keys must be sorted and unique")
            elif node[0] in {"list", "concat"}:
                pending.extend((child, depth + 1) for child in node[1])
            else:
                raise ValueError("unknown JSON node")
        return list(paths)

    def decode(self, descriptor: dict) -> bytes:
        self.paths(descriptor)

        def read(node):
            kind = node[0]
            if kind == "blob":
                return self._read(node)
            if kind == "map":
                return {key: read(child) for key, child in node[1]}
            values = [read(child) for child in node[1]]
            if kind == "concat":
                if not all(isinstance(value, list) for value in values):
                    raise ValueError("JSON concat requires arrays")
                return [item for value in values for item in value]
            return values

        envelope = read(descriptor["tree"])
        if envelope["ref"]["artifact_id"] != descriptor["artifactId"]:
            raise ValueError("JSON descriptor identity mismatch")
        raw = canonical(envelope)
        if (
            len(raw) != descriptor["envelopeBytes"]
            or hashlib.sha256(raw).hexdigest() != descriptor["envelopeSha256"]
        ):
            raise ValueError("JSON envelope checksum mismatch")
        return raw
