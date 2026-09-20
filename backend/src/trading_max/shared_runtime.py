"""Share verified, read-only installed dependencies between retained releases.

Never link application data or source a pool blob from an external package
cache inode. A new blob is independently copied, checked and fsynced before
atomic alias replacement. Each retained release keeps a hard link, so removing
another release or the pool name cannot break it.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

from .infrastructure.durable_files import atomic_bytes, sync_directory

_NAME = re.compile(r"([0-9a-f]{64})-(444|555)")


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def candidates(release: Path, minimum_bytes: int = 4096) -> Iterator[Path]:
    roots = [
        *release.glob(".venv/lib/python*/site-packages"),
        release / "apps/web/.next/standalone/node_modules",
        release / ".git/objects/pack",
    ]
    for root in roots:
        if root.is_symlink() or not root.resolve().is_relative_to(release):
            raise ValueError("shared dependency root escapes its release")
        for path in sorted(root.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            if path.resolve() != path:
                raise ValueError("shared dependency path follows a symlink")
            if any(part in {"__pycache__", ".cache"} for part in path.relative_to(root).parts):
                continue
            if path.suffix in {".pyc", ".pyo", ".pth"} or path.stat().st_size < minimum_bytes:
                continue
            if root == release / ".git/objects/pack" and path.suffix not in {".pack", ".idx"}:
                continue
            yield path


def share_dependencies(release: Path, pool: Path, *, minimum_bytes: int = 4096) -> dict:
    release = release.resolve(strict=True)
    pool = pool.absolute()
    if pool.resolve() != pool or pool.is_relative_to(release):
        raise ValueError("shared runtime pool must be separate from its release")
    if minimum_bytes < 4096:
        raise ValueError("runtime sharing requires a positive useful file threshold")
    pool.mkdir(parents=True, exist_ok=True, mode=0o700)
    linked = reused = independent = fallback = 0
    for source in candidates(release, minimum_bytes):
        before = source.stat()
        sha = file_digest(source)
        permissions = 0o555 if before.st_mode & 0o111 else 0o444
        blob = pool / f"{sha}-{permissions:o}"
        if blob.is_symlink():
            raise ValueError("shared runtime blob must not be a symlink")
        if not blob.exists():
            fd, name = tempfile.mkstemp(prefix=".pending-", dir=pool)
            temporary = Path(name)
            try:
                with os.fdopen(fd, "wb") as target, source.open("rb") as original:
                    while block := original.read(1024 * 1024):
                        target.write(block)
                    target.flush()
                    os.fsync(target.fileno())
                if file_digest(temporary) != sha:
                    raise ValueError("runtime source changed during independent copy")
                temporary.chmod(permissions)
                temporary.replace(blob)
                sync_directory(pool)
                independent += before.st_size
            finally:
                temporary.unlink(missing_ok=True)
        metadata = blob.stat()
        if (
            stat.S_IMODE(metadata.st_mode) != permissions
            or (metadata.st_uid, metadata.st_gid) != (before.st_uid, before.st_gid)
            or file_digest(blob) != sha
        ):
            raise ValueError("shared runtime blob has unexpected contents or permissions")
        if (before.st_dev, before.st_ino) == (metadata.st_dev, metadata.st_ino):
            reused += 1
            continue
        current = source.stat()
        if (
            current.st_dev,
            current.st_ino,
            current.st_size,
            current.st_mtime_ns,
            current.st_ctime_ns,
        ) != (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) or file_digest(source) != sha:
            raise ValueError("runtime source changed before alias replacement")
        alias = source.with_name(".shared-" + uuid.uuid4().hex)
        try:
            try:
                os.link(blob, alias)
            except OSError as exc:
                if exc.errno not in {errno.EXDEV, errno.EPERM, errno.ENOTSUP}:
                    raise
                fallback += 1  # Preserve the independent original on other filesystems.
                continue
            alias.replace(source)
            sync_directory(source.parent)
        finally:
            alias.unlink(missing_ok=True)
        if file_digest(source) != sha or source.stat().st_mode & 0o222:
            raise ValueError("shared runtime alias failed verification")
        linked += 1
    result = {
        "schemaVersion": 1,
        "linkedFiles": linked,
        "alreadySharedFiles": reused,
        "independentPoolBytesAdded": independent,
        "independentFallbackFiles": fallback,
    }
    atomic_bytes(release / ".runtime-sharing.json", json.dumps(result, sort_keys=True).encode())
    return result


def orphan_dependencies(pool: Path, cutoff: float) -> list[Path]:
    if pool.resolve() != pool:
        raise ValueError("shared runtime pool must not be a symlink")
    result = []
    for path in pool.iterdir() if pool.exists() else []:
        match = _NAME.fullmatch(path.name)
        if not match or path.is_symlink() or not path.is_file():
            continue
        info = path.stat()
        if info.st_nlink != 1 or info.st_mtime >= cutoff:
            continue
        if stat.S_IMODE(info.st_mode) != int(match[2], 8) or file_digest(path) != match[1]:
            raise ValueError("orphan runtime dependency is corrupt or writable")
        result.append(path)
    return result
