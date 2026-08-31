"""Validate a Trading Max backup archive without extracting it."""

from __future__ import annotations

import argparse
import tarfile
from pathlib import Path, PurePosixPath

FORBIDDEN_COMPONENTS = {"secrets"}
FORBIDDEN_SUFFIXES = (".env", ".log")


def _validate_member(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe archive path: {name}")
    if any(component in FORBIDDEN_COMPONENTS for component in path.parts):
        raise ValueError(f"secret-bearing archive path: {name}")
    if path.name.endswith(FORBIDDEN_SUFFIXES):
        raise ValueError(f"excluded runtime file in archive: {name}")


def verify_archive(archive: Path) -> list[str]:
    """Return member names after validating the archive's safety contract."""

    if not archive.is_file():
        raise FileNotFoundError(f"backup archive does not exist: {archive}")
    with tarfile.open(archive, mode="r:gz") as handle:
        members = handle.getmembers()
    names = [member.name for member in members]
    if len(names) != len(set(names)):
        raise ValueError("backup archive contains duplicate paths")
    for member in members:
        _validate_member(member.name)
        if member.issym() or member.islnk() or member.isdev():
            raise ValueError(f"unsafe archive member type: {member.name}")
    if not any(name == "state" or name.startswith("state/") for name in names):
        raise ValueError("backup archive does not contain a state directory")
    return names


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    names = verify_archive(args.archive.expanduser().resolve())
    print(f"backup archive verified: {len(names)} members")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
