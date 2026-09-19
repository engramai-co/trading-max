"""Create, verify or restore an independently deduplicated recovery snapshot."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from trading_max.backup_repository import BackupRepository
from trading_max.service_retention import ServiceRetention


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--state-root", type=Path, required=True)
    create.add_argument("--label", default="manual")
    create.add_argument("--retain-for-service", type=Path)
    archive_import = sub.add_parser("import-archive")
    archive_import.add_argument("archive", type=Path)
    archive_import.add_argument("--max-bytes", type=int, default=64 * 1024**3)
    verify = sub.add_parser("verify")
    verify.add_argument("backup_id")
    restore = sub.add_parser("restore")
    restore.add_argument("backup_id")
    restore.add_argument("destination", type=Path)
    args = parser.parse_args()
    repository = BackupRepository(args.repository)
    if args.command == "create":
        maintenance = ServiceRetention(args.retain_for_service) if args.retain_for_service else None
        if maintenance and maintenance.repository.root != repository.root:
            raise ValueError("nightly retention must use this service's backup repository")
        result = repository.create(args.state_root, label=args.label)
        if maintenance:
            result["retention"] = maintenance.maintain_repository(result["id"])
    elif args.command == "import-archive":
        result = repository.import_archive(args.archive, max_bytes=args.max_bytes)
    elif args.command == "verify":
        result = repository.verify(args.backup_id)
    else:
        result = repository.restore(args.backup_id, args.destination)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
