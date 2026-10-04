"""Share identical chunks inside independent recovery, with unchanged readers."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath

from .infrastructure.durable_files import atomic_bytes
from .infrastructure.manifest_catalog import FORMAT, PREFIX
from .infrastructure.object_packs import MAGIC, MAX_BYTES, MAX_INDEX, decode
from .infrastructure.pack_rewrite import adopt, compact
from .infrastructure.verified_chunks import ChunkPathCache
from .physical_recovery import raw_path

POLICY = "shared-recovery-packs-policy.json"
PACK_PREFIX = "artifacts/object-packs/blocks/"


def enabled(repository) -> bool:
    path = repository.root / POLICY
    if path.is_symlink():
        raise ValueError("recovery sharing policy must not be a symlink")
    return path.is_file() and json.loads(path.read_bytes()) == {"schemaVersion": 1, "enabled": True}


def structured_file(name: str) -> bool:
    return name.startswith(PACK_PREFIX) and name.endswith(".pack")


def keep_structured(repository, path: Path) -> bool:
    if not enabled(repository):
        return False
    with path.open("rb") as stream:
        return stream.read(len(MAGIC)) == MAGIC


def roots(repository) -> tuple[set[str], set[str], dict[str, int]]:
    """Every existing manifest remains a root, including old recovery dates."""
    direct, chunks, digests, candidates = set(), set(), set(), {}
    cache = ChunkPathCache()
    with repository.packs.scan_reads(), repository.packed_store.packs.scan_reads():
        for path in sorted(repository.snapshots.glob("*.json")):
            descriptor = json.loads(path.read_bytes())
            if descriptor.get("$format") == FORMAT:
                key = "manifest/" + path.stem
                direct.add(key)
                record = json.loads(repository.packs.read(key))
                if "raw" not in record:
                    for reference in record["files"]:
                        if type(reference) is not int or not 1 <= reference < 2**64:
                            raise ValueError("invalid recovery catalog reference")
                        direct.add(PREFIX + f"{reference:016x}")
            manifest = repository.read_manifest(path.stem)
            for name, entry in manifest["files"].items():
                digest = entry["sha256"]
                digests.add(digest)
                if structured_file(name):
                    if PurePosixPath(name).stem != digest:
                        raise ValueError("recovery pack filename disagrees with its checksum")
                    size = entry["size"]
                    if type(size) is not int or not 0 < size <= MAX_BYTES + MAX_INDEX + 1024**2:
                        raise ValueError("invalid recovery pack size")
                    if digest in candidates and candidates[digest] != size:
                        raise ValueError("conflicting recovery pack sizes")
                    candidates[digest] = size
        for number, digest in enumerate(sorted(digests), 1):
            if number % 128 == 0:
                repository._progress(
                    "recovery-sharing-roots", files=number, totalFiles=len(digests)
                )
            if raw_path(repository, digest).is_file():
                continue
            descriptor = repository.packed_descriptor(digest)
            if descriptor is not None:
                if not repository.packed_path(digest).is_file():
                    direct.add("descriptor/" + digest)
                for path in repository.packed_store.logical_paths(descriptor, path_cache=cache):
                    if not path.is_file():
                        kind = "json" if path.parent.parent.name == "json-chunks" else "history"
                        chunks.add(kind + "/" + path.stem)
            elif not repository.blob_path(digest).is_file():
                direct.add("blob/" + digest)
    # Unknown namespaces are not garbage merely because this version cannot
    # interpret their owners. Keep them through backwards-compatible maintenance.
    direct.update(
        key
        for key in list(repository.packs.keys())
        if not key.startswith(("blob/", "descriptor/", "entry/", "manifest/"))
    )
    chunks.update(
        key
        for key in list(repository.packed_store.packs.keys())
        if not key.startswith(("json/", "history/"))
    )
    return direct, chunks, candidates


def _already_shared(repository, required: set[str]) -> set[str]:
    pool = repository.packed_store.packs
    reader = pool._reader()
    if reader is None:
        return set()
    shared = set()
    for (digest,) in reader.execute("SELECT digest FROM packs"):
        original = raw_path(repository, digest)
        if original.is_file() and original.samefile(pool.path(digest)):
            shared.add(digest)
    return {
        key
        for key, digest in reader.execute("SELECT key,pack FROM records")
        if digest in shared and key in required
    }


def share(
    repository, journals: Path, *, max_files=65536, max_bytes=2 * 1024**3, window=None
) -> dict:
    if not enabled(repository) or min(max_files, max_bytes) <= 0:
        raise ValueError("recovery sharing requires activation and positive budgets")
    repository.packs.recover_pending()
    repository.packed_store.packs.recover_pending()
    direct, needed, candidates = roots(repository)
    remaining = needed - _already_shared(repository, needed)
    converted = copied = scanned = 0
    deferred = False
    with repository.packs.scan_reads(), repository.packed_store.packs.scan_reads():
        for digest, size in sorted(candidates.items()):
            if not remaining:
                break
            if (
                (window and window.stopped())
                or converted >= max_files
                or scanned + size > max_bytes
            ):
                deferred = True
                break
            original = raw_path(repository, digest)
            alias = repository.packed_store.packs.path(digest)
            if original.is_file() and alias.is_file() and original.samefile(alias):
                continue  # Adoption indexes every record; pending publications were recovered above.
            with repository.open_blob(digest) as stream:
                content = stream.read(size + 1)
            scanned += size
            if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("independent recovery pack bytes failed verification")
            entries, _ = decode(content)
            selected = set(entries) & remaining
            if not selected:
                continue
            if not original.exists():
                atomic_bytes(original, content)
                copied += len(content)
            elif original.read_bytes() != content:
                raise ValueError("original recovery pack changed")
            # Both endpoints are inside this recovery repository. No application
            # state, temporary checkpoint or external package path is linked.
            adopt(repository.packed_store.packs, original, set(entries))
            remaining.difference_update(selected)
            converted += 1
            repository._progress(
                "sharing-recovery-packs", files=converted, remainingChunks=len(remaining)
            )
    # Relocation may leave formerly rooted outer blobs and chunk packs redundant.
    # Recompute roots after publication, not from the old representation.
    direct, needed, _ = roots(repository)
    main = compact(repository.packs, direct, journals / "blobs", window=window)
    packed = compact(repository.packed_store.packs, needed, journals / "chunks", window=window)
    return {
        "sharedPacks": converted,
        "independentBytesAdded": copied,
        "scannedBytes": scanned,
        "unmatchedChunks": len(remaining),
        "blobs": main,
        "chunks": packed,
        "remainingFiles": int(deferred or bool(window and window.reason)),
    }
