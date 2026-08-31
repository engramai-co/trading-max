"""Safely restore an external Trading Max state root from a verified archive."""

from __future__ import annotations

import argparse
import tarfile
import tempfile
from pathlib import Path

from tools.verify_backup_archive import verify_archive

CONFIRMATION = "RESTORE_TRADING_MAX_STATE"


def restore_archive(
    archive: Path,
    destination: Path,
    *,
    confirmation: str,
    safety_backup: Path | None = None,
) -> Path | None:
    """Restore only the state member and return the safety backup path."""

    if confirmation != CONFIRMATION:
        raise PermissionError(f"restore requires confirmation token {CONFIRMATION!r}")
    archive = archive.expanduser().resolve()
    destination = destination.expanduser().resolve()
    verify_archive(archive)
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    safety = safety_backup.expanduser().resolve() if safety_backup else None
    if safety is not None and safety.exists():
        raise FileExistsError(f"safety backup already exists: {safety}")

    with tempfile.TemporaryDirectory(prefix=".trading_max-restore-", dir=parent) as temporary:
        staging = Path(temporary)
        with tarfile.open(archive, mode="r:gz") as handle:
            members = [
                member
                for member in handle.getmembers()
                if member.name == "state" or member.name.startswith("state/")
            ]
            handle.extractall(staging, members=members, filter="data")
        restored = staging / "state"
        if not restored.is_dir():
            raise ValueError("archive did not contain a state directory")
        if safety is None and destination.exists():
            raise ValueError("existing destination requires an explicit safety_backup path")

        moved_old = False
        try:
            if destination.exists():
                if safety is None:
                    raise ValueError("existing destination requires a safety backup")
                destination.replace(safety)
                moved_old = True
            restored.replace(destination)
        except Exception:
            if moved_old and safety is not None and not destination.exists():
                safety.replace(destination)
            raise
    return safety if moved_old else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--confirm", required=True)
    parser.add_argument("--safety-backup", type=Path, required=True)
    args = parser.parse_args()
    safety = restore_archive(
        args.archive,
        args.destination,
        confirmation=args.confirm,
        safety_backup=args.safety_backup,
    )
    print(f"Trading Max state restored; previous state moved to {safety}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
