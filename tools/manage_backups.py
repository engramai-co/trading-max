"""Create, verify or restore an independently deduplicated recovery snapshot."""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from trading_max.backup_repository import BackupRepository
from trading_max.pack_maintenance import nightly_packs
from trading_max.service_retention import ServiceRetention
from trading_max.storage_budget import nightly_storage


def report_progress(details: dict) -> None:
    # Keep stdout a single machine-readable result, including for deployments.
    print(json.dumps({"at": datetime.now(UTC).isoformat(), **details}), file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--max-seconds", type=float, default=1800)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--state-root", type=Path, required=True)
    create.add_argument("--label", default="manual")
    create.add_argument("--artifact-encoding", choices=("physical", "logical"), default="physical")
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
    if not 0 < args.max_seconds < float("inf"):
        parser.error("--max-seconds must be finite and positive")
    deadline = time.monotonic() + args.max_seconds

    def progress(details: dict) -> None:
        report_progress(details)
        # Check between files and maintenance stages, never interrupt an atomic
        # publication or a journaled removal halfway through its write.
        if time.monotonic() > deadline:
            raise TimeoutError("backup time budget exceeded; inspect progress before retrying")

    repository = BackupRepository(args.repository, progress=progress)
    if args.command == "create":
        maintenance = ServiceRetention(args.retain_for_service) if args.retain_for_service else None
        if maintenance and maintenance.repository.root != repository.root:
            raise ValueError("nightly retention must use this service's backup repository")
        result = repository.create(
            args.state_root, label=args.label, artifact_encoding=args.artifact_encoding
        )
        if maintenance:
            maintenance.repository.progress = progress
            try:
                progress({"phase": "packing", "backupId": result["id"]})
                result["packing"] = nightly_packs(
                    maintenance.service, args.state_root, result["id"], progress=progress
                )
                progress({"phase": "retention", "backupId": result["id"]})
                result["retention"] = maintenance.maintain_repository(result["id"])
            finally:
                # A blocked cleanup must not hide continuing capacity growth.
                report_progress({"phase": "storage-census"})
                result["storage"] = nightly_storage(maintenance.service, args.state_root)
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
