"""Lossless shared JSON subtrees for repeated research envelopes.

Only physical representation changes. Stable object keys and fixed array groups
reuse unchanged data; no financial records or provenance are removed.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from pathlib import Path

from .history_chunks import atomic_bytes, canonical
from .object_packs import ObjectPacks
from .verified_chunks import VerifiedChunkCache, read_packable_chunk, read_packable_chunks

FORMAT = "trading-max-json-v1"
MAX_BYTES = 256 * 1024 * 1024
TARGET_BYTES = 128 * 1024
GROUP_ITEMS = 128
_DIGEST = re.compile(r"[0-9a-f]{64}")


class JsonChunks:
    def __init__(self, artifact_root: Path, *, packs: ObjectPacks | None = None):
        self.root = artifact_root / "json-chunks"
        self.read_cache: VerifiedChunkCache | None = None
        self.packs = packs or ObjectPacks(artifact_root / "object-packs")

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
        if path.exists() or self.packs.contains("json/" + digest):
            self._read(node)
        else:
            atomic_bytes(path, gzip.compress(raw, compresslevel=3, mtime=0))
        return node

    def _read(self, node: list) -> object:
        _, digest, size = node
        if type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise ValueError("invalid JSON block size")
        raw = read_packable_chunk(
            self.path(digest), size, digest, self.packs, "json/" + digest, self.read_cache
        )
        return json.loads(raw)

    def _encode(self, value: object, depth: int = 0) -> list:
        if depth > 64:
            raise ValueError("JSON tree exceeds depth limit")
        raw = canonical(value)
        if len(raw) <= TARGET_BYTES or not isinstance(value, (dict, list)):
            return self._store(raw)
        if isinstance(value, dict):
            return ["map", [[key, self._encode(value[key], depth + 1)] for key in sorted(value)]]
        if len(value) > 16:
            group_items = GROUP_ITEMS if len(value) > GROUP_ITEMS else 16
            return [
                "concat",
                [
                    self._encode(value[i : i + group_items], depth + 1)
                    for i in range(0, len(value), group_items)
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
        return list(self._blocks(descriptor))

    def _blocks(self, descriptor: dict) -> dict[Path, list]:
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
                path = self.path(node[1])
                if path in paths and paths[path] != node:
                    raise ValueError("conflicting JSON block claims")
                paths[path] = node
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
        return paths

    def decode(self, descriptor: dict) -> bytes:
        blocks = self._blocks(descriptor)
        chunks = read_packable_chunks(
            [(path, node[2], node[1], "json/" + node[1]) for path, node in blocks.items()],
            self.packs,
            self.read_cache,
            max_bytes=MAX_BYTES,
        )

        def read(node):
            kind = node[0]
            if kind == "blob":
                return json.loads(chunks["json/" + node[1]])
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
