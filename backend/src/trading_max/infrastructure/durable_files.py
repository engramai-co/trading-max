"""Durable private file publication shared by immutable storage formats."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


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
