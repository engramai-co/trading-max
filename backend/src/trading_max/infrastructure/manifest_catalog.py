"""Exact recovery manifests referencing immutable, deduplicated file entries.

Integer references are persistent record keys, not SQLite rowids. Both the
catalog and the original manifest bytes can be recovered from the sealed packs
without a parent snapshot, a live state directory, or an old database image.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from .object_packs import ObjectPacks

FORMAT = "trading-max-backup-catalog-v1"
PREFIX = "entry/"


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class ManifestCatalog:
    def __init__(self, packs: ObjectPacks):
        self.packs = packs

    def encode(self, raw: bytes, backup_id: str) -> dict:
        self.packs.recover_pending()
        manifest = json.loads(raw)
        key = "manifest/" + backup_id
        # Preserve noncanonical imported JSON verbatim instead of guessing its
        # whitespace, escaping, key order or unknown fields.
        if canonical(manifest) != raw:
            record = {"raw": raw.decode("utf-8")}
        else:
            files = manifest.get("files")
            if not isinstance(files, dict):
                raise ValueError("backup file catalog is missing")
            last = self.packs.last_key(PREFIX)
            counter = int(last.removeprefix(PREFIX), 16) if last else 0
            entries = {}
            seen = {}
            references = []
            for path, entry in sorted(files.items()):
                encoded = canonical([path, entry])
                digest = hashlib.sha256(encoded).hexdigest()
                reference = seen.get(digest) or self.packs.find(digest, PREFIX)
                if reference is None:
                    counter += 1
                    reference = PREFIX + f"{counter:016x}"
                    entries[reference] = encoded
                    seen[digest] = reference
                    if len(entries) >= 4096:
                        self.packs.add(entries)
                        entries = {}
                references.append(int(reference.removeprefix(PREFIX), 16))
            if entries:
                self.packs.add(entries)
            record = {
                "header": {k: v for k, v in manifest.items() if k != "files"},
                "files": references,
            }
        self.packs.add({key: canonical(record)})
        descriptor = {
            "$format": FORMAT,
            "id": backup_id,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        if self.decode(descriptor) != raw:
            raise ValueError("backup manifest catalog failed exact comparison")
        return descriptor

    def decode(self, descriptor: Mapping) -> bytes:
        if descriptor.get("$format") != FORMAT:
            raise ValueError("unsupported backup catalog")
        record = json.loads(self.packs.read("manifest/" + descriptor["id"]))
        if "raw" in record:
            raw = record["raw"].encode()
        else:
            files = {}
            for reference in record["files"]:
                if type(reference) is not int or not 1 <= reference < 2**64:
                    raise ValueError("invalid backup file reference")
                name, entry = json.loads(self.packs.read(PREFIX + f"{reference:016x}"))
                if name in files:
                    raise ValueError("duplicate backup file reference")
                files[name] = entry
            raw = canonical({**record["header"], "files": files})
        if (
            len(raw) != descriptor["bytes"]
            or hashlib.sha256(raw).hexdigest() != descriptor["sha256"]
        ):
            raise ValueError("backup manifest catalog checksum mismatch")
        return raw
