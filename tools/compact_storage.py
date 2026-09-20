"""Verify rollback compatibility and run bounded physical storage compaction."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.storage_compatibility import verify_retained_readers
from trading_max.storage_migration import StateCompactor, compact_repository


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check-readers")
    for name in ("state", "backups"):
        command = sub.add_parser(name)
        command.add_argument("--state-root", type=Path, required=True)
        command.add_argument("--verified-backup-id", required=True)
        command.add_argument("--max-files", type=int, default=256)
        command.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    args = parser.parse_args()
    service = args.service_root.resolve(strict=True)
    with exclusive_lock(service / ".deployment.lock"):
        readers = verify_retained_readers(service)
        if args.command == "check-readers":
            result = readers
        else:
            repository = BackupRepository(service / "backups/repository")
            manifest = json.loads(repository.manifest_path(args.verified_backup_id).read_text())
            state = args.state_root.resolve(strict=True)
            if manifest.get("sourceState") != str(state):
                raise ValueError("recovery snapshot does not belong to this state")
            if datetime.fromisoformat(manifest["createdAt"]) < datetime.now(UTC) - timedelta(
                days=1
            ):
                raise ValueError("compaction requires a recovery snapshot from the last 24 hours")
            if not repository.verify(args.verified_backup_id).get("snapshotRunId"):
                raise ValueError("compaction requires a verified published snapshot")
            if args.command == "state":
                with exclusive_lock(repository.lock):
                    result = StateCompactor(state, service / "maintenance/storage-migrations").run(
                        max_files=args.max_files, max_bytes=args.max_bytes
                    )
            else:
                result = compact_repository(
                    repository, max_files=args.max_files, max_bytes=args.max_bytes
                )
            result["compatibility"] = readers
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
